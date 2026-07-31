import os from 'node:os'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { detectAgents } from '@harness/adapter-acp'
import {
  ErrorCode,
  methods,
  PROTOCOL_VERSION,
  RequestSchema,
  type MethodName,
  type ProviderId,
} from '@harness/contracts'
import { Orchestrator } from './orchestrator.js'
import { detectProviders } from './providers.js'
import { PushBus } from './push-bus.js'
import { Store } from './store.js'
import { readWorkspace } from './workspace.js'

export const SERVER_VERSION = '0.0.0'
export const DEFAULT_PORT = 4311

/**
 * Where the database lives.
 *
 * Under the platform's own per-user data directory rather than beside the
 * binary, so an update or a reinstall does not take someone's history with it.
 * `HARNESS_DATA_DIR` overrides it, which is what the tests and a portable
 * install use.
 */
function storeLocation(): string {
  const override = process.env['HARNESS_DATA_DIR']
  if (override) return path.join(override, 'harness.db')

  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? (process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'))

  return path.join(base, 'PersonalHarness', 'harness.db')
}

/**
 * The local core server. Owns all state; clients are thin renderers.
 *
 * Every inbound payload is validated against the declared method schema before
 * it reaches any logic, and the failure is reported as structured data rather
 * than a stack trace — "invalid message" in a log tells you nothing at 2am.
 */
export function startServer(
  options: {
    port?: number
    host?: string
    accessToken?: string | undefined
  } = {},
) {
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  assertSafeBind(host, options.accessToken)
  const wss = new WebSocketServer({ port, host })
  const push = new PushBus()

  // A port clash is the most likely startup failure — a previous run that did
  // not shut down cleanly. An unhandled 'error' event crashes the process with
  // a stack trace that tells the user nothing.
  wss.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[server] port ${port} is already in use — another Personal Harness server is ` +
          `probably still running. Stop it, or set HARNESS_PORT to a free port.`,
      )
      process.exit(1)
    }
    console.error(`[server] ${error.message}`)
    process.exit(1)
  })

  const store = new Store(storeLocation())
  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event) => push.broadcast('thread.event', { threadId, event }),
    onLog: (line) => console.log(`[agent] ${line}`),
    onLogin: (provider, result) => push.broadcast('auth.event', { provider, ...result }),
  })

  // A previous run killed mid-session leaves git believing in checkouts that
  // are gone. Clearing that up at startup means the next session on that path
  // starts instead of failing with a message about our own leftovers.
  void orchestrator.recoverWorktrees().catch(() => undefined)

  wss.on('connection', (socket, request) => {
    if (!hasAccess(request.url, options.accessToken)) {
      socket.close(1008, 'Access denied')
      return
    }
    push.add(socket)
    push.send(socket, 'server.welcome', {
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    })

    socket.on('message', (raw) => void handleMessage(socket, raw.toString()))
    socket.on('close', () => push.remove(socket))
  })

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    const envelope = RequestSchema.safeParse(parsed)
    if (!envelope.success) {
      console.warn('[server] dropped malformed request')
      return
    }
    const { id, method, params } = envelope.data

    const spec = methods[method as MethodName]
    if (!spec) {
      respondError(socket, id, ErrorCode.BAD_REQUEST, `unknown method: ${method}`)
      return
    }

    const decoded = spec.params.safeParse(params)
    if (!decoded.success) {
      const first = decoded.error.issues[0]
      respondError(
        socket,
        id,
        ErrorCode.BAD_REQUEST,
        `invalid params for ${method}`,
        first ? `${first.path.join('.') || '(root)'}: ${first.message}` : undefined,
      )
      return
    }

    try {
      const result = await route(method as MethodName, decoded.data)
      socket.send(JSON.stringify({ id, result }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      respondError(socket, id, ErrorCode.INTERNAL, message)
    }
  }

  async function route(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case 'system.info':
        return {
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          platform: process.platform,
        }

      case 'providers.list':
        return { providers: await detectProviders() }

      case 'auth.status': {
        const p = params as { provider: ProviderId }
        return orchestrator.account(p.provider)
      }

      case 'auth.startLogin': {
        const p = params as { provider: ProviderId }
        return orchestrator.startLogin(p.provider)
      }

      case 'auth.cancelLogin': {
        const p = params as { provider: ProviderId; loginId: string }
        await orchestrator.cancelLogin(p.provider, p.loginId)
        return {}
      }

      case 'auth.useApiKey': {
        const p = params as { provider: ProviderId; apiKey: string }
        return orchestrator.useApiKey(p.provider, p.apiKey)
      }

      case 'auth.signOut': {
        const p = params as { provider: ProviderId }
        await orchestrator.signOut(p.provider)
        return {}
      }

      case 'workspace.info': {
        const p = params as { path: string }
        return readWorkspace(p.path)
      }

      case 'models.list': {
        const p = params as { provider: ProviderId }
        return { models: await orchestrator.listModels(p.provider) }
      }

      case 'acp.agents': {
        const agents = await detectAgents()
        return {
          agents: agents.map(({ id, name, installed, verified, install }) => ({
            id,
            name,
            installed,
            verified,
            ...(install === undefined ? {} : { install }),
          })),
        }
      }

      case 'projects.list':
        return {
          projects: store.projects().map((project) => ({
            ...project,
            sessions: store.threads(project.path).map((thread) => ({
              id: thread.id,
              title: thread.title,
              provider: thread.provider,
              ...(thread.agent === undefined ? {} : { agent: thread.agent }),
              createdAt: thread.createdAt,
              running: orchestrator.isRunning(thread.id),
              ...(thread.worktreeBranch === undefined
                ? {}
                : { worktreeBranch: thread.worktreeBranch }),
              ...(thread.closedAt === undefined ? {} : { closedAt: thread.closedAt }),
            })),
          })),
        }

      case 'projects.add': {
        const p = params as { path: string; name?: string }
        return store.addProject(p.path, p.name)
      }

      case 'projects.pin': {
        const p = params as { path: string; pinned: boolean }
        store.setPinned(p.path, p.pinned)
        return {}
      }

      case 'projects.rename': {
        const p = params as { path: string; name: string }
        store.renameProject(p.path, p.name)
        return {}
      }

      case 'projects.remove': {
        const p = params as { path: string }
        // Close anything still running under it first, or the processes
        // outlive the thing that owned them.
        for (const thread of store.threads(p.path)) orchestrator.close(thread.id)
        store.removeProject(p.path)
        return {}
      }

      case 'thread.rename': {
        const p = params as { threadId: string; title: string }
        store.renameThread(p.threadId, p.title)
        return {}
      }

      case 'thread.delete': {
        const p = params as { threadId: string }
        if (store.thread(p.threadId)?.worktreePath) {
          throw new Error('discard the isolated session checkout before deleting it')
        }
        orchestrator.close(p.threadId)
        store.deleteThread(p.threadId)
        return {}
      }

      case 'thread.history': {
        const p = params as { threadId: string; afterSeq?: number }
        return {
          events: orchestrator.history(p.threadId, p.afterSeq ?? 0),
          running: orchestrator.isRunning(p.threadId),
        }
      }

      case 'usage.summary': {
        const p = params as { threadId: string }
        const thread = store.thread(p.threadId)
        if (!thread) throw new Error('thread not found')
        const startOfToday = new Date()
        startOfToday.setHours(0, 0, 0, 0)
        return {
          ...store.usageSummary(p.threadId, startOfToday.getTime()),
          limits: await orchestrator.usageLimits(thread.provider),
        }
      }

      case 'thread.start': {
        const p = params as {
          provider: ProviderId
          agent?: string
          workspacePath: string
          model?: string
          serviceTier?: string
          effort?: string
          approval?: 'ask' | 'auto' | 'full'
          isolate?: boolean
        }
        const thread = await orchestrator.startThread(p.provider, p.workspacePath, {
          model: p.model,
          serviceTier: p.serviceTier,
          effort: p.effort,
          approval: p.approval,
          agent: p.agent,
          isolate: p.isolate,
        })
        return { threadId: thread.id }
      }

      case 'thread.checkpoints': {
        const p = params as { threadId: string }
        return {
          checkpoints: orchestrator.checkpoints(p.threadId).map((entry) => ({
            id: entry.id,
            seq: entry.seq,
            label: entry.label,
            createdAt: entry.createdAt,
          })),
        }
      }

      case 'thread.changedSince': {
        const p = params as { threadId: string; checkpointId: number }
        return { files: await orchestrator.changedSinceCheckpoint(p.threadId, p.checkpointId) }
      }

      case 'thread.restore': {
        const p = params as { threadId: string; checkpointId: number }
        return orchestrator.restoreCheckpoint(p.threadId, p.checkpointId)
      }

      case 'thread.undoRestore': {
        const p = params as { threadId: string; undo: string }
        await orchestrator.undoRestore(p.threadId, p.undo)
        return {}
      }

      case 'thread.unsavedWork': {
        const p = params as { threadId: string }
        const stored = store.thread(p.threadId)
        return {
          isolated: stored?.worktreePath !== undefined,
          uncommitted: await orchestrator.hasUnsavedWork(p.threadId),
        }
      }

      case 'thread.discardWorktree': {
        const p = params as { threadId: string; force?: boolean }
        await orchestrator.discardWorktree(p.threadId, p.force ?? false)
        return {}
      }

      case 'thread.sendTurn': {
        const p = params as {
          threadId: string
          text: string
          attachments?: string[]
          model?: string
          effort?: string
          serviceTier?: string
        }
        return {
          turnId: await orchestrator.sendTurn(p.threadId, p.text, p.attachments, {
            model: p.model,
            effort: p.effort,
            serviceTier: p.serviceTier,
          }),
        }
      }

      case 'thread.respondToApproval': {
        const p = params as {
          threadId: string
          approvalId: string
          decision: 'approve' | 'approve-session' | 'deny' | 'abort'
        }
        orchestrator.respondToApproval(p.threadId, p.approvalId, p.decision)
        return {}
      }

      case 'thread.interrupt': {
        const p = params as { threadId: string }
        await orchestrator.interrupt(p.threadId)
        return {}
      }

      case 'thread.close': {
        const p = params as { threadId: string }
        orchestrator.close(p.threadId)
        return {}
      }
    }
  }

  function respondError(
    socket: WebSocket,
    id: string,
    code: string,
    message: string,
    detail?: string,
  ): void {
    socket.send(JSON.stringify({ id, error: { code, message, ...(detail ? { detail } : {}) } }))
  }

  console.log(`[server] listening on ws://${host}:${port}`)

  return {
    port,
    close: () => {
      orchestrator.disposeAll()
      store.close()
      wss.close()
    },
  }
}

export function hasAccess(requestUrl: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true
  const supplied = new URL(requestUrl ?? '/', 'ws://harness.local').searchParams.get('token')
  if (!supplied) return false

  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  )
}

export function assertSafeBind(host: string, accessToken: string | undefined): void {
  const loopback = host === '::1' || (isIPv4(host) && host.startsWith('127.'))
  if (!loopback && !accessToken) {
    throw new Error('HARNESS_ACCESS_TOKEN is required when HARNESS_HOST is not loopback')
  }
}
