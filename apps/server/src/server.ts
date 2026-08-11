import os, { type NetworkInterfaceInfo } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
  type MethodName,
  type McpServerConfig,
  type ParamsOf,
  type ProviderId,
  type SidebarSettings,
} from '@harness/contracts'
import { StaleDiffSnapshotError } from './diff-review.js'
import { MobileAccess, type MobileConnectionAccess } from './mobile-access.js'
import { Orchestrator } from './orchestrator.js'
import { detectProviders, installCommandFor, launchCommandFor } from './providers.js'
import { checkForUpdates } from './update-check.js'
import { PushBus } from './push-bus.js'
import { loadOrCreateWebClientToken } from './mobile-web-token.js'
import { PreviewCaptureCoordinator } from './preview-capture.js'
import { browseProjectDirectory } from './project-directory-browser.js'
import { PullRequestService } from './pull-requests.js'
import { DEFAULT_PORT } from './server-config.js'
import { Store } from './store.js'
import { imageFileName, materializeAttachment } from './uploaded-attachment.js'
import { UsageHistoryService } from './usage-history.js'
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
    /** Long-lived token for the full web app on a phone. Defaults to the OS
     * credential store. */
    webToken?: string
    /** Directory containing the built web app. Defaults to apps/web/dist. */
    webRoot?: string
    /** Vite dev server the mobile web-app surface proxies to in dev. */
    webDevServerUrl?: string
    /** Where to probe for a live Vite dev server; `false` disables the probe. */
    webDevServerProbeUrl?: string | false
    projectBrowserHome?: string
  } = {},
) {
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  const mobilePort = options.mobilePort ?? (port === 0 ? 0 : port + 1)
  const webToken = options.webToken ?? loadOrCreateWebClientToken()
  if (options.webToken === undefined && webToken === '') {
    console.warn('[server] no OS credential store available — the mobile web app is disabled')
  }
  const webRoot = resolveWebRoot(options.webRoot)
  if (options.webDevServerUrl) {
    console.log(`[server] serving the web app for phones from ${options.webDevServerUrl}`)
  } else if (webRoot) {
    console.log(`[server] serving the web app for phones from ${webRoot}`)
  } else {
    console.warn('[server] web app build not found (apps/web/dist) — the phone web app is disabled')
  }
  assertSafeBind(host, options.accessToken)
  const wss = new WebSocketServer({ port, host })
  const push = new PushBus()
  const previewCapture = new PreviewCaptureCoordinator((socket, request) =>
    push.send(socket, 'preview.captureRequested', request),
  )

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

  const databasePath = storeLocation()
  const store = new Store(databasePath)
  const usageHistory = new UsageHistoryService({
    cacheFile: path.join(path.dirname(databasePath), 'usage-history.json'),
    harnessUsage: () => store.usageEvents(),
  })
  const pullRequests = new PullRequestService()
  void usageHistory.startBackgroundRefresh()
  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event, seq) => push.broadcast('thread.event', { threadId, event, seq }),
    onQueue: (threadId, state) => push.broadcast('thread.queue', { threadId, ...state }),
    onLog: (line) => console.log(`[agent] ${line}`),
    onLogin: (provider, result) => push.broadcast('auth.event', { provider, ...result }),
    onMcpOAuth: (provider, projectPath, result) =>
      push.broadcast('mcp.oauth', { provider, projectPath, ...result }),
    onMcpChanged: (provider, projectPath) =>
      push.broadcast('mcp.changed', { provider, projectPath }),
    onSkillsChanged: (provider, projectPath) =>
      push.broadcast('skills.changed', { provider, projectPath }),
    onLifecycle: (threadId, lifecycle) =>
      push.broadcast('thread.lifecycle', { threadId, lifecycle }),
    onTerminalOutput: (terminalId, data) => push.broadcast('terminal.output', { terminalId, data }),
    onTerminalExit: (terminalId, exitCode) =>
      push.broadcast('terminal.exit', { terminalId, exitCode }),
    capturePreview: (url, viewports) =>
      previewCapture.available
        ? previewCapture.capture(url, viewports)
        : Promise.resolve(undefined),
  })
  orchestrator.refreshLifecycle()
  const lifecycleTimer = setInterval(() => orchestrator.refreshLifecycle(), 30_000)
  lifecycleTimer.unref()
  const mobileAccess = new MobileAccess({
    store,
    port: mobilePort,
    onConnection: (socket, request, access) => acceptConnection(socket, request, access),
    webToken,
    webRoot,
    webDevServerUrl: options.webDevServerUrl,
    ...(options.webDevServerProbeUrl !== undefined
      ? { webDevServerProbeUrl: options.webDevServerProbeUrl }
      : {}),
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

  // The web app for phones is part of the running server: reachable on every
  // launch so the bookmarked URL keeps working. Native-app connections are
  // restored separately from the persisted switch.
  void mobileAccess
    .start()
    .catch((error) => console.error(`[server] could not start mobile access: ${messageOf(error)}`))
  if (store.mobileAccessEnabled()) {
    mobileAccess.setProtocolEnabled(true)
  }

  async function startPairing() {
    return mobileAccess.startPairing()
  }

  wss.on('connection', (socket, request) => {
    if (!allowedOrigin(request.headers.origin, options.accessToken)) {
      socket.close(1008, 'Origin not allowed')
      return
    }
    if (!hasAccess(request.url, options.accessToken)) {
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
      socket.send(JSON.stringify({ channel: 'server.welcome', sequence: 1, data: welcome }))
    } else {
      push.add(socket)
      push.send(socket, 'server.welcome', welcome)
    }

    socket.on('message', (raw) =>
      handleMessage(socket, raw.toString(), access).catch((error) =>
        console.error(`[server] request handling failed: ${String(error)}`),
      ),
    )
    const removeSocket = () => {
      previewCapture.remove(socket)
      if (access.kind !== 'pairing') push.remove(socket)
    }
    socket.on('close', removeSocket)
    // Without a handler, a client resetting its connection emits 'error' on a
    // bare EventEmitter and crashes the whole server.
    socket.on('error', removeSocket)
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

    // hasOwn, not truthiness: `methods` is a plain object, so 'constructor',
    // 'toString' and friends pass a truthy check and then blow up on
    // spec.params — outside the try below, so no reply is ever sent and the
    // client's call hangs until the socket closes.
    const spec = Object.hasOwn(methods, method) ? methods[method as MethodName] : undefined
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
      const result = await route(socket, method as MethodName, decoded.data, access)
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id, result }))
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
    socket: WebSocket,
    method: MethodName,
    params: unknown,
    access: ConnectionAccess,
  ): Promise<unknown> {
    switch (method) {
      case 'client.capabilities':
        previewCapture.setCapability(
          socket,
          (params as ParamsOf<'client.capabilities'>).previewCapture,
        )
        return {}

      case 'preview.captureResult':
        previewCapture.complete(socket, params as ParamsOf<'preview.captureResult'>)
        return {}

      case 'system.info':
        return {
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          platform: process.platform,
        }

      case 'system.panicStop':
        return orchestrator.panicStop()

      case 'system.updateCheck':
        return checkForUpdates()

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

      case 'pullRequests.list': {
        const p = params as ParamsOf<'pullRequests.list'>
        return pullRequests.list(
          store.projects().map((project) => project.path),
          p.refresh ?? false,
        )
      }

      case 'pullRequests.detail': {
        const p = params as ParamsOf<'pullRequests.detail'>
        return pullRequests.detail(
          p.repository,
          p.number,
          store.projects().map((project) => project.path),
          p.refresh ?? false,
        )
      }

      case 'pullRequests.files': {
        const p = params as ParamsOf<'pullRequests.files'>
        return pullRequests.files(p.repository, p.number, p.page ?? 1, p.refresh ?? false)
      }

      case 'pullRequests.metadataOptions': {
        const p = params as ParamsOf<'pullRequests.metadataOptions'>
        return pullRequests.metadataOptions(p.repository, p.refresh ?? false)
      }

      case 'pullRequests.action': {
        const p = params as ParamsOf<'pullRequests.action'>
        return pullRequests.action(p.repository, p.number, p.action)
      }

      case 'providers.list':
        return { providers: await detectProviders() }

      case 'providers.install': {
        const p = params as ParamsOf<'providers.install'>
        const command = installCommandFor(p.provider, p.agent)
        const target = p.agent ? `${p.provider}:${p.agent}` : p.provider
        return { terminalId: orchestrator.installProvider(target, command, p.columns, p.rows) }
      }

      case 'providers.launch': {
        const p = params as ParamsOf<'providers.launch'>
        const command = launchCommandFor(p.provider, p.agent)
        const target = p.agent ? `${p.provider}:${p.agent}` : p.provider
        return {
          terminalId: orchestrator.launchProviderLogin(target, command, p.columns, p.rows),
        }
      }

      case 'connections.list':
        return { connections: orchestrator.listModelConnections() }

      case 'connections.upsert':
        return {
          connection: orchestrator.upsertModelConnection(params as ParamsOf<'connections.upsert'>),
        }

      case 'connections.setCredential': {
        const p = params as { connectionId: string; apiKey: string }
        orchestrator.setModelConnectionCredential(p.connectionId, p.apiKey)
        return { credentialConfigured: true }
      }

      case 'connections.remove': {
        const p = params as { connectionId: string }
        orchestrator.removeModelConnection(p.connectionId)
        return {}
      }

      case 'connections.models': {
        const p = params as { connectionId: string }
        return { models: await orchestrator.listConnectionModels(p.connectionId) }
      }

      case 'connections.status':
        return mobileAccess.status()

      case 'connections.startPairing': {
        return startPairing()
      }

      case 'connections.stop':
        store.setMobileAccessEnabled(false)
        mobileAccess.setProtocolEnabled(false)
        return {}

      case 'connections.revoke': {
        const p = params as ParamsOf<'connections.revoke'>
        mobileAccess.revoke(p.deviceId)
        return {}
      }

      case 'connections.deviceStatus': {
        const status = mobileAccess.status()
        return { serverName: status.serverName, addresses: status.addresses }
      }

      case 'connections.claim': {
        const p = params as ParamsOf<'connections.claim'>
        if (access.kind !== 'pairing') throw new Error('A current pairing ticket is required')
        return mobileAccess.claim(access, p.name)
      }

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
        const p = params as { provider: ProviderId; agent?: string }
        return orchestrator.account(p.provider, p.agent)
      }

      case 'auth.startLogin': {
        const p = params as { provider: ProviderId; agent?: string }
        return orchestrator.startLogin(p.provider)
      }

      case 'auth.cancelLogin': {
        const p = params as { provider: ProviderId; agent?: string; loginId: string }
        await orchestrator.cancelLogin(p.provider, p.loginId)
        return {}
      }

      case 'auth.useApiKey': {
        const p = params as { provider: ProviderId; agent?: string; apiKey: string }
        return orchestrator.useApiKey(p.provider, p.apiKey)
      }

      case 'auth.signOut': {
        const p = params as { provider: ProviderId; agent?: string }
        await orchestrator.signOut(p.provider, p.agent)
        return {}
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
        const p = params as { provider: ProviderId; agent?: string }
        return { models: await orchestrator.listModels(p.provider, p.agent) }
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
          agents: agents.map(({ id, name, installed, verified, install, setup, problem }) => ({
            id,
            name,
            installed,
            verified,
            setup,
            ...(install === undefined ? {} : { install }),
            ...(problem === undefined ? {} : { problem }),
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
              pinned: thread.pinned,
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

      case 'projects.browse': {
        const p = params as ParamsOf<'projects.browse'>
        return browseProjectDirectory(p.path, options.projectBrowserHome)
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
        // An isolated session's checkout can only be discarded through its
        // own thread id, and removing the project hides every one of them
        // from the sidebar — so the worktree and its branch would survive
        // with nothing left able to reach them. Refuse instead, naming what
        // the user has to deal with first.
        const isolated = store.threads(p.path).filter((thread) => thread.worktreePath)
        if (isolated.length > 0) {
          throw new Error(
            `${isolated.length} isolated session${isolated.length === 1 ? '' : 's'} in this project still ` +
              `own a private checkout. Discard or keep those first.`,
          )
        }
        // The sidebar entry can disappear while its history remains available
        // when the project is added again. Running processes still need an owner.
        for (const thread of store.threads(p.path)) orchestrator.close(thread.id)
        orchestrator.forgetProject(p.path)
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
        const p = params as ParamsOf<'attachments.saveImage'>
        return {
          path: await materializeAttachment({ name: imageFileName(p.mimeType), data: p.data }),
        }
      }

      case 'attachments.saveFile': {
        const p = params as ParamsOf<'attachments.saveFile'>
        return { path: await materializeAttachment({ name: p.name, data: p.data }) }
      }

      case 'thread.rename': {
        const p = params as { threadId: string; title: string }
        store.renameThread(p.threadId, p.title)
        return {}
      }

      case 'thread.pin': {
        const p = params as { threadId: string; pinned: boolean }
        store.setThreadPinned(p.threadId, p.pinned)
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
        const p = params as { threadId: string } | { provider: ProviderId }
        const thread = 'threadId' in p ? store.thread(p.threadId) : undefined
        if ('threadId' in p && !thread) throw new Error('thread not found')
        const provider = thread?.provider ?? ('provider' in p ? p.provider : undefined)
        if (!provider) throw new Error('provider not found')
        const startOfToday = new Date()
        startOfToday.setHours(0, 0, 0, 0)
        const empty = {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        }
        return {
          ...('threadId' in p
            ? store.usageSummary(p.threadId, startOfToday.getTime())
            : { session: empty, today: empty }),
          limits: await orchestrator.usageLimits(provider),
        }
      }

      case 'usage.history': {
        const p = params as ParamsOf<'usage.history'>
        return usageHistory.history(p.range, p.refresh ?? false)
      }

      case 'usage.resetHistory':
        await usageHistory.resetAndRefresh()
        return { started: true as const }

      case 'thread.start': {
        const p = params as {
          provider: ProviderId
          agent?: string
          connectionId?: string
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
          connectionId: p.connectionId,
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
          ...(await orchestrator.submitTurn(p.threadId, p.text, p.attachments, {
            model: p.model,
            effort: p.effort,
            serviceTier: p.serviceTier,
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

      case 'thread.moveQueuedTurn': {
        const p = params as {
          threadId: string
          queuedTurnId: string
          direction: 'up' | 'down'
        }
        orchestrator.moveQueuedTurn(p.threadId, p.queuedTurnId, p.direction)
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

      case 'thread.setApproval': {
        const p = params as { threadId: string; approval: 'ask' | 'auto' | 'auto-review' | 'full' }
        orchestrator.setThreadApproval(p.threadId, p.approval)
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
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify({ id, error: { code, message, ...(detail ? { detail } : {}) } }))
  }

  console.log(`[server] listening on ws://${host}:${port}`)

  return {
    port,
    startPairing,
    close: async () => {
      clearInterval(lifecycleTimer)
      usageHistory.dispose()
      const orchestratorClosed = orchestrator.disposeAll()
      for (const socket of wss.clients) socket.terminate()
      const results = await Promise.allSettled([
        orchestratorClosed,
        mobileAccess.stop(),
        new Promise<void>((resolve) => wss.close(() => resolve())),
      ])
      store.close()
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'server shutdown failed')
    },
  }
}

/**
 * Which pages may open a socket to us.
 *
 * Browsers do not apply the same-origin policy to WebSocket, so binding to
 * loopback is not a trust boundary: any page the user visits could otherwise
 * connect and drive the agent — list their repos, start a thread with `full`
 * approval, or open a terminal.
 *
 * Allowed: no Origin at all (non-browser clients — the CLI, tests, a native
 * mobile client), `file://` (the packaged Electron renderer), and loopback
 * origins (the dev server and our own web UI).
 *
 * `null` is NOT allowed, and must never be added back. It is the opaque
 * origin, and any page can mint one on demand — `<iframe sandbox=
 * "allow-scripts" srcdoc=…>` or a `data:` document — so allowing it hands the
 * gate straight back to the attacker it exists to stop. If a renderer of ours
 * ever reports an opaque origin, the answer is an access token for that
 * surface, not a hole here.
 *
 * When the server binds beyond loopback — a Tailscale or LAN address so a
 * phone can reach the web UI — an access token is mandatory (see
 * assertSafeBind), and that token becomes the trust boundary: any origin may
 * attempt the handshake, but only a connection carrying the token is admitted.
 * The dev:mobile flow serves the page from the same host, so its origin would
 * otherwise be bounced here before the token was ever checked.
 */
export function allowedOrigin(origin: string | undefined, accessToken?: string): boolean {
  if (!origin || origin === 'file://') return true
  if (origin === 'null') return false
  let hostname: string
  try {
    ;({ hostname } = new URL(origin))
  } catch {
    return false
  }
  if (accessToken) return true
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    (isIPv4(hostname) && hostname.startsWith('127.'))
  )
}

type ConnectionAccess = { kind: 'admin' } | MobileConnectionAccess

const DEVICE_METHODS = new Set<MethodName>([
  'system.info',
  'providers.list',
  'connections.list',
  'connections.models',
  'connections.deviceStatus',
  'workspace.info',
  'workspace.branches',
  'workspace.switchBranch',
  'models.list',
  'acp.agents',
  'projects.list',
  'projects.browse',
  'projects.add',
  'attachments.saveFile',
  'thread.history',
  'thread.queue',
  'thread.start',
  'thread.rename',
  'thread.sendTurn',
  'thread.settle',
  'thread.unsettle',
  'thread.close',
  'thread.delete',
  'thread.diff',
  'thread.reviewFile',
  'thread.unsavedWork',
  'thread.interrupt',
  'thread.respondToApproval',
  'thread.respondToUserInput',
  'thread.deleteQueuedTurn',
  'thread.steerQueuedTurn',
])

function methodAllowed(access: ConnectionAccess, method: MethodName): boolean {
  if (access.kind === 'admin') return method !== 'connections.claim'
  if (access.kind === 'pairing') return method === 'connections.claim'
  return DEVICE_METHODS.has(method)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Where the built web app lives. Defaults to apps/web/dist beside this
 * package; HARNESS_WEB_DIST overrides it (tests, packaging).
 */
function resolveWebRoot(option: string | undefined): string | undefined {
  const candidate = option ?? process.env['HARNESS_WEB_DIST']
  if (candidate) return candidate
  const relative = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  return existsSync(relative) ? relative : undefined
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
