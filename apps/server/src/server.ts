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
import { PushBus } from './push-bus.js'
import { readWorkspace } from './workspace.js'

export const SERVER_VERSION = '0.0.0'
export const DEFAULT_PORT = 4311

/**
 * The local core server. Owns all state; clients are thin renderers.
 *
 * Every inbound payload is validated against the declared method schema before
 * it reaches any logic, and the failure is reported as structured data rather
 * than a stack trace — "invalid message" in a log tells you nothing at 2am.
 */
export function startServer(port = DEFAULT_PORT) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
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

  const orchestrator = new Orchestrator({
    onEvent: (threadId, event) => push.broadcast('thread.event', { threadId, event }),
    onLog: (line) => console.log(`[agent] ${line}`),
    onLogin: (provider, result) => push.broadcast('auth.event', { provider, ...result }),
  })

  wss.on('connection', (socket) => {
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
        // Real detection lands with the setup wizard in M2. Until then this
        // reports only what M0 actually implements, rather than pretending.
        return {
          providers: [
            { id: 'codex', displayName: 'Codex', installed: true, auth: 'unknown' as const },
          ],
        }

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

      case 'thread.start': {
        const p = params as {
          provider: ProviderId
          agent?: string
          workspacePath: string
          model?: string
          effort?: string
          approval?: 'ask' | 'auto' | 'full'
        }
        const thread = await orchestrator.startThread(p.provider, p.workspacePath, {
          model: p.model,
          effort: p.effort,
          approval: p.approval,
          agent: p.agent,
        })
        return { threadId: thread.id }
      }

      case 'thread.sendTurn': {
        const p = params as { threadId: string; text: string; attachments?: string[] }
        return { turnId: await orchestrator.sendTurn(p.threadId, p.text, p.attachments) }
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

  console.log(`[server] listening on ws://127.0.0.1:${port}`)

  return {
    port,
    close: () => {
      orchestrator.disposeAll()
      wss.close()
    },
  }
}
