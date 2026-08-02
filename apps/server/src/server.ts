import os, { type NetworkInterfaceInfo } from 'node:os'
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
  type DiffDecision,
  type ApprovalMode,
  type MethodName,
  type McpServerConfig,
  type ParamsOf,
  type ProviderId,
  type SidebarSettings,
  type ResultOf,
} from '@harness/contracts'
import { StaleDiffSnapshotError } from './diff-review.js'
import { Orchestrator } from './orchestrator.js'
import { detectProviders } from './providers.js'
import { PushBus } from './push-bus.js'
import { MobileAccess, type MobileConnectionAccess } from './mobile-access.js'
import { DEFAULT_PORT } from './server-config.js'
import { Store } from './store.js'
import { imageFileName, materializeAttachment } from './uploaded-attachment.js'
import { listWorkspaceBranches, readWorkspace, switchWorkspaceBranch } from './workspace.js'

export const SERVER_VERSION = '0.0.0'
export { DEFAULT_PORT } from './server-config.js'

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
    mobilePort?: number
    mobileNetworkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
    resolveTailscaleAddresses?: () => Promise<ReadonlySet<string>>
  } = {},
) {
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  const mobilePort = options.mobilePort ?? (port === 0 ? 0 : port + 1)
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
    onQueue: (threadId, state) => push.broadcast('thread.queue', { threadId, ...state }),
    onLog: (line) => console.log(`[agent] ${line}`),
    onLogin: (provider, result) => push.broadcast('auth.event', { provider, ...result }),
    onMcpOAuth: (provider, projectPath, result) =>
      push.broadcast('mcp.oauth', { provider, projectPath, ...result }),
    onSkillsChanged: (provider, projectPath) =>
      push.broadcast('skills.changed', { provider, projectPath }),
    onLifecycle: (threadId, lifecycle) =>
      push.broadcast('thread.lifecycle', { threadId, lifecycle }),
    onTerminalOutput: (terminalId, data) => push.broadcast('terminal.output', { terminalId, data }),
    onTerminalExit: (terminalId, exitCode) =>
      push.broadcast('terminal.exit', { terminalId, exitCode }),
  })
  orchestrator.refreshLifecycle()
  const lifecycleTimer = setInterval(() => orchestrator.refreshLifecycle(), 30_000)
  lifecycleTimer.unref()
  const mobileAccess = new MobileAccess({
    store,
    port: mobilePort,
    onConnection: (socket, request, access) => acceptConnection(socket, request, access),
    ...(options.mobileNetworkInterfaces
      ? { networkInterfaces: options.mobileNetworkInterfaces }
      : {}),
    ...(options.resolveTailscaleAddresses
      ? { resolveTailscaleAddresses: options.resolveTailscaleAddresses }
      : {}),
  })

  // A previous run killed mid-session leaves git believing in checkouts that
  // are gone. Clearing that up at startup means the next session on that path
  // starts instead of failing with a message about our own leftovers.
  void orchestrator.recoverWorktrees().catch(() => undefined)

  if (store.mobileAccessEnabled()) {
    void mobileAccess
      .start()
      .catch((error) =>
        console.error(`[server] could not restore mobile access: ${messageOf(error)}`),
      )
  }

  async function startPairing(): Promise<ResultOf<'connections.startPairing'>> {
    const offer = await mobileAccess.startPairing()
    store.setMobileAccessEnabled(true)
    return offer
  }

  wss.on('connection', (socket, request) => {
    if (
      !hasAccess(
        request.url,
        options.accessToken,
        request.headers.origin,
        request.headers['user-agent'],
        request.socket.remoteAddress,
      )
    ) {
      socket.close(1008, 'Access denied')
      return
    }
    acceptConnection(socket, request, { kind: 'admin' })
  })

  function acceptConnection(socket: WebSocket, _request: unknown, access: ConnectionAccess): void {
    const welcome = {
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    }

    if (access.kind === 'pairing') {
      // A QR ticket may only be exchanged for a device credential. Keeping its
      // socket out of the broadcast pool prevents an unclaimed code from
      // observing thread or account events while it waits to be claimed.
      socket.send(JSON.stringify({ channel: 'server.welcome', sequence: 1, data: welcome }))
    } else {
      push.add(socket)
      push.send(socket, 'server.welcome', welcome)
    }

    socket.on('message', (raw) => void handleMessage(socket, raw.toString(), access))
    if (access.kind !== 'pairing') socket.on('close', () => push.remove(socket))
  }

  async function handleMessage(
    socket: WebSocket,
    raw: string,
    access: ConnectionAccess,
  ): Promise<void> {
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

    if (access.kind === 'device' && !mobileAccess.isDeviceActive(access.deviceId)) {
      respondError(socket, id, ErrorCode.FORBIDDEN, 'This device has been revoked')
      socket.terminate()
      return
    }

    const spec = methods[method as MethodName]
    if (!spec) {
      respondError(socket, id, ErrorCode.BAD_REQUEST, `unknown method: ${method}`)
      return
    }

    if (!methodAllowed(access, method as MethodName)) {
      respondError(socket, id, ErrorCode.FORBIDDEN, 'This connection cannot perform that action')
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
      const result = await route(method as MethodName, decoded.data, access)
      socket.send(JSON.stringify({ id, result }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      respondError(
        socket,
        id,
        error instanceof StaleDiffSnapshotError ? ErrorCode.STALE_SNAPSHOT : ErrorCode.INTERNAL,
        message,
      )
    }
  }

  async function route(
    method: MethodName,
    params: unknown,
    access: ConnectionAccess,
  ): Promise<unknown> {
    switch (method) {
      case 'system.info':
        return {
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          platform: process.platform,
        }

      case 'system.panicStop':
        return orchestrator.panicStop()

      case 'search.sessions':
        return store.searchSessions(
          params as {
            query: string
            projectPath?: string
            provider?: ProviderId
            cursor?: string
            limit?: number
          },
        )

      case 'providers.list':
        return { providers: await detectProviders() }

      case 'mcp.list': {
        const p = params as { provider: ProviderId; projectPath: string }
        return orchestrator.listMcpServers(p.provider, p.projectPath)
      }

      case 'mcp.add': {
        const p = params as {
          provider: ProviderId
          projectPath: string
          server: McpServerConfig
        }
        orchestrator.addMcpServer(p.provider, p.projectPath, p.server)
        return {}
      }

      case 'mcp.update': {
        const p = params as {
          provider: ProviderId
          projectPath: string
          server: McpServerConfig
        }
        orchestrator.updateMcpServer(p.provider, p.projectPath, p.server)
        return {}
      }

      case 'mcp.remove': {
        const p = params as { provider: ProviderId; projectPath: string; serverId: string }
        orchestrator.removeMcpServer(p.provider, p.projectPath, p.serverId)
        return {}
      }

      case 'mcp.reload': {
        const p = params as { provider: ProviderId; projectPath: string }
        await orchestrator.reloadMcpServers(p.provider, p.projectPath)
        return {}
      }

      case 'mcp.startOAuth': {
        const p = params as { provider: ProviderId; projectPath: string; serverId: string }
        return orchestrator.startMcpOAuth(p.provider, p.projectPath, p.serverId)
      }

      case 'mcp.cancelOAuth': {
        const p = params as { provider: ProviderId }
        return orchestrator.cancelMcpOAuth(p.provider)
      }

      case 'skills.list': {
        const p = params as { provider: ProviderId; projectPath: string }
        return orchestrator.listSkills(p.provider, p.projectPath)
      }

      case 'skills.setEnabled': {
        const p = params as {
          provider: ProviderId
          projectPath: string
          skillId: string
          enabled: boolean
        }
        return {
          enabled: await orchestrator.setSkillEnabled(
            p.provider,
            p.projectPath,
            p.skillId,
            p.enabled,
          ),
        }
      }

      case 'skills.installFromFolder': {
        const p = params as {
          provider: ProviderId
          projectPath: string
          folderPath: string
        }
        return {
          skill: await orchestrator.installSkillFromFolder(p.provider, p.projectPath, p.folderPath),
        }
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

      case 'connections.status':
        return mobileAccess.status()

      case 'connections.startPairing': {
        return startPairing()
      }

      case 'connections.stop':
        store.setMobileAccessEnabled(false)
        await mobileAccess.stop()
        return {}

      case 'connections.revoke': {
        const p = params as { deviceId: string }
        mobileAccess.revoke(p.deviceId)
        return {}
      }

      case 'connections.deviceStatus': {
        const status = mobileAccess.status()
        return { serverName: status.serverName, addresses: status.addresses }
      }

      case 'connections.claim': {
        const p = params as { name: string }
        if (access.kind !== 'pairing') throw new Error('A current pairing ticket is required')
        return mobileAccess.claim(access, p.name)
      }

      case 'workspace.info': {
        const p = params as { path: string }
        return readWorkspace(p.path)
      }

      case 'workspace.branches': {
        const p = params as { path: string }
        return { branches: await listWorkspaceBranches(p.path) }
      }

      case 'workspace.switchBranch': {
        const p = params as { path: string; branch: string }
        const localSessionRunning = store
          .threads(p.path)
          .some((thread) => !thread.worktreePath && orchestrator.isRunning(thread.id))
        if (localSessionRunning) {
          throw new Error('stop local sessions in this project before switching branches')
        }
        return switchWorkspaceBranch(p.path, p.branch)
      }

      case 'models.list': {
        const p = params as { provider: ProviderId }
        return { models: await orchestrator.listModels(p.provider) }
      }

      case 'voice.status': {
        const p = params as { provider: ProviderId }
        return orchestrator.voiceStatus(p.provider)
      }

      case 'voice.transcribe':
        return orchestrator.transcribeVoice(params as ParamsOf<'voice.transcribe'>)

      case 'voice.cancel': {
        const p = params as { requestId: string }
        orchestrator.cancelVoice(p.requestId)
        return {}
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
        orchestrator.refreshLifecycle()
        return {
          projects: store.projects().map((project) => ({
            ...project,
            sessions: store.threads(project.path).map((thread) => ({
              id: thread.id,
              title: thread.title,
              provider: thread.provider,
              ...(thread.agent === undefined ? {} : { agent: thread.agent }),
              createdAt: thread.createdAt,
              running: orchestrator.isTurnRunning(thread.id),
              status: orchestrator.inboxStatus(thread.id),
              unread: thread.unread,
              lifecycle: thread.lifecycle,
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

      case 'terminal.open': {
        const p = params as { threadId: string; columns: number; rows: number }
        return { terminalId: orchestrator.openTerminal(p.threadId, p.columns, p.rows) }
      }

      case 'terminal.input': {
        const p = params as { terminalId: string; data: string }
        orchestrator.writeTerminal(p.terminalId, p.data)
        return {}
      }

      case 'terminal.resize': {
        const p = params as { terminalId: string; columns: number; rows: number }
        orchestrator.resizeTerminal(p.terminalId, p.columns, p.rows)
        return {}
      }

      case 'terminal.close': {
        const p = params as { terminalId: string }
        orchestrator.closeTerminal(p.terminalId)
        return {}
      }

      case 'attachments.saveImage': {
        const p = params as { mimeType: string; data: string }
        return {
          path: await materializeAttachment({ name: imageFileName(p.mimeType), data: p.data }),
        }
      }

      case 'attachments.saveFile': {
        const p = params as { name: string; mimeType: string; data: string }
        return { path: await materializeAttachment({ name: p.name, data: p.data }) }
      }

      case 'thread.rename': {
        const p = params as { threadId: string; title: string }
        store.renameThread(p.threadId, p.title)
        return {}
      }

      case 'thread.settle': {
        const p = params as { threadId: string }
        return { lifecycle: orchestrator.settleThread(p.threadId) }
      }

      case 'thread.unsettle': {
        const p = params as { threadId: string }
        return { lifecycle: orchestrator.unsettleThread(p.threadId) }
      }

      case 'thread.snooze': {
        const p = params as { threadId: string; wakeAt: number }
        return { lifecycle: orchestrator.snoozeThread(p.threadId, p.wakeAt) }
      }

      case 'thread.unsnooze': {
        const p = params as { threadId: string }
        return { lifecycle: orchestrator.unsnoozeThread(p.threadId) }
      }

      case 'thread.setKeepActive': {
        const p = params as { threadId: string; keepActive: boolean }
        return { lifecycle: orchestrator.setThreadKeepActive(p.threadId, p.keepActive) }
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
        const result = {
          events: orchestrator.history(p.threadId, p.afterSeq ?? 0),
          running: orchestrator.isTurnRunning(p.threadId),
        }
        orchestrator.markThreadRead(p.threadId)
        return result
      }

      case 'thread.diff': {
        const p = params as { threadId: string }
        return orchestrator.diff(p.threadId)
      }

      case 'thread.reviewHunk': {
        const p = params as {
          threadId: string
          version: string
          path: string
          hunkId: string
          decision: DiffDecision
        }
        return {
          diff: await orchestrator.reviewHunk(p.threadId, p.version, p.path, p.hunkId, p.decision),
        }
      }

      case 'thread.reviewFile': {
        const p = params as {
          threadId: string
          version: string
          path: string
          decision: DiffDecision
        }
        return {
          diff: await orchestrator.reviewFile(p.threadId, p.version, p.path, p.decision),
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
          approval?: 'ask' | 'auto' | 'auto-review' | 'full'
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
          approval?: ApprovalMode
        }
        return {
          ...(await orchestrator.submitTurn(p.threadId, p.text, p.attachments, {
            model: p.model,
            effort: p.effort,
            serviceTier: p.serviceTier,
            approval: p.approval,
          })),
        }
      }

      case 'thread.queue': {
        const p = params as { threadId: string }
        return orchestrator.queue(p.threadId)
      }

      case 'thread.deleteQueuedTurn': {
        const p = params as { threadId: string; queuedTurnId: string }
        orchestrator.deleteQueuedTurn(p.threadId, p.queuedTurnId)
        return {}
      }

      case 'thread.steerQueuedTurn': {
        const p = params as { threadId: string; queuedTurnId: string }
        await orchestrator.steerQueuedTurn(p.threadId, p.queuedTurnId)
        return {}
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

      case 'thread.respondToUserInput': {
        const p = params as {
          threadId: string
          requestId: string
          answers: Record<string, string[]>
        }
        orchestrator.respondToUserInput(p.threadId, p.requestId, p.answers)
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

      case 'sidebar.settings':
        return store.sidebarSettings()

      case 'sidebar.updateSettings': {
        const settings = store.updateSidebarSettings(params as Partial<SidebarSettings>)
        push.broadcast('sidebar.settings', settings)
        orchestrator.refreshLifecycle()
        return settings
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
    startPairing,
    close: async () => {
      clearInterval(lifecycleTimer)
      orchestrator.disposeAll()
      for (const socket of wss.clients) socket.terminate()
      await Promise.all([
        mobileAccess.stop(),
        new Promise<void>((resolve) => wss.close(() => resolve())),
      ])
      store.close()
    },
  }
}

type ConnectionAccess = { kind: 'admin' } | MobileConnectionAccess

const DEVICE_METHODS = new Set<MethodName>([
  'system.info',
  'providers.list',
  'auth.status',
  'connections.deviceStatus',
  'workspace.branches',
  'workspace.switchBranch',
  'models.list',
  'projects.list',
  'attachments.saveFile',
  'thread.history',
  'thread.rename',
  'thread.start',
  'thread.sendTurn',
  'thread.queue',
  'thread.deleteQueuedTurn',
  'thread.steerQueuedTurn',
  'thread.respondToApproval',
  'thread.interrupt',
  'thread.settle',
  'thread.unsettle',
  'thread.close',
])

function methodAllowed(access: ConnectionAccess, method: MethodName): boolean {
  if (access.kind === 'admin') return method !== 'connections.claim'
  if (access.kind === 'pairing') return method === 'connections.claim'
  return DEVICE_METHODS.has(method)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function hasAccess(
  requestUrl: string | undefined,
  expected: string | undefined,
  origin?: string,
  userAgent?: string,
  remoteAddress?: string,
): boolean {
  // Local native clients such as the headless CLI cannot inherit the dev
  // launcher's ephemeral browser token. Originless access is safe only across
  // loopback; native connections arriving over LAN or Tailscale still need it.
  if (origin === undefined && isLoopbackAddress(remoteAddress)) return true
  if (!expected) return trustedAdminOrigin(origin, userAgent)
  const supplied = new URL(requestUrl ?? '/', 'ws://harness.local').searchParams.get('token')
  if (!supplied) return false

  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  )
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.replace(/^::ffff:/, '')
  return normalized === '::1' || (isIPv4(normalized) && normalized.startsWith('127.'))
}

function trustedAdminOrigin(origin: string | undefined, userAgent: string | undefined): boolean {
  // Native clients do not send Origin. Browser clients must come from our
  // loopback Vite server or the packaged Electron file renderer.
  if (origin === undefined || origin === 'file://') return true
  if (origin === 'null') return /\bElectron\/\d/.test(userAgent ?? '')
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === '::1' || (isIPv4(url.hostname) && url.hostname.startsWith('127.'))
  } catch {
    return false
  }
}

export function assertSafeBind(host: string, accessToken: string | undefined): void {
  const loopback = host === '::1' || (isIPv4(host) && host.startsWith('127.'))
  if (!loopback && !accessToken) {
    throw new Error('HARNESS_ACCESS_TOKEN is required when HARNESS_HOST is not loopback')
  }
}
