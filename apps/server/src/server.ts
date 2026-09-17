import { timingSafeEqual } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { ErrorCode, methods, PROTOCOL_VERSION, type MethodName } from '@harness/contracts'
import { applyDesktopPath } from '@harness/proc/desktop-path'
import { readWorkspaceDiff, StaleDiffSnapshotError } from './diff-review.js'
import { Orchestrator, resolveWorkspacePath, type LifecycleScheduleHint } from './orchestrator.js'
import { checkForUpdates } from './update-check.js'
import { PushBus } from './push-bus.js'
import { storeLocation } from './data-location.js'
import { acquireDataLease } from './data-lease.js'
import { PreviewCaptureCoordinator } from './preview-capture.js'
import type { PullRequestService } from './pull-requests.js'
import { DEFAULT_PORT } from './server-config.js'
import { Store } from './store.js'
import { createProjectListProjector, type ProjectListState } from './project-list.js'
import { imageFileName, materializeAttachment } from './uploaded-attachment.js'
import { usageSummaryWithLimits } from './usage-summary.js'
import { listWorkspaceBranches, readWorkspace } from './workspace.js'
import { listWorkspaceDirectory, readWorkspaceTextFile } from './workspace-files.js'
import { LifecycleScheduler } from './lifecycle-scheduler.js'
import { parseFrequentMethodParams, parseRequestEnvelope } from './request-envelope.js'
import { createHistoryResponseProjector } from './history-response.js'
import { createSerializedResultCache, serializeSuccessResponse } from './response-serializer.js'
import { ProviderHistory } from './provider-history.js'

const SERVER_VERSION = '0.0.0'
export { DEFAULT_PORT } from './server-config.js'

const startupStartedAt = Number(process.env['HARNESS_STARTUP_STARTED_AT'])
const startupMilestones = new Set<string>()

function reportStartupMilestone(name: string): void {
  if (!Number.isFinite(startupStartedAt) || startupStartedAt <= 0 || startupMilestones.has(name)) {
    return
  }
  startupMilestones.add(name)
  console.log(`[startup] ${name} ${Date.now() - startupStartedAt}ms`)
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
  applyDesktopPath()
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  assertSafeBind(host, options.accessToken)
  const databasePath = storeLocation()
  const releaseDataLease = acquireDataLease(databasePath)
  let store: Store
  try {
    store = new Store(databasePath)
  } catch (error) {
    releaseDataLease()
    throw error
  }
  let wss: WebSocketServer
  try {
    wss = new WebSocketServer({ port, host })
  } catch (error) {
    try {
      store.close()
    } finally {
      releaseDataLease()
    }
    throw error
  }
  const push = new PushBus()
  const providerService = import('./providers.js')
  let updatesService: Promise<import('./provider-updates.js').ProviderUpdateService> | undefined
  const providerUpdates = () =>
    (updatesService ??= import('./provider-updates.js').then(
      ({ ProviderUpdateService }) => new ProviderUpdateService(),
    ))
  void providerService.then(({ prewarmProviders }) => prewarmProviders()).catch(() => undefined)
  const previewCapture = new PreviewCaptureCoordinator(
    (socket, request) => push.send(socket, 'preview.captureRequested', request),
    35_000,
    (socket, requestId) => push.send(socket, 'preview.captureCancelled', { requestId }),
  )

  // A port clash is the most likely startup failure — a previous run that did
  // not shut down cleanly. An unhandled 'error' event crashes the process with
  // a stack trace that tells the user nothing.
  wss.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[server] port ${port} is already in use — another TasteCode server is ` +
          `probably still running. Stop it, or set HARNESS_PORT to a free port.`,
      )
      process.exit(1)
    }
    console.error(`[server] ${error.message}`)
    process.exit(1)
  })

  reportStartupMilestone('server-store-ready')
  store.recoverInterruptedThreads()
  reportStartupMilestone('server-recovery-ready')
  let pullRequests: Promise<PullRequestService> | undefined
  const pullRequestService = () =>
    (pullRequests ??= import('./pull-requests.js').then(
      ({ PullRequestService }) => new PullRequestService(),
    ))
  let notifyLifecycleScheduleChanged: (hint?: LifecycleScheduleHint) => void = () => {}
  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event, seq, serializedEvent) => {
      if (serializedEvent === undefined) {
        push.broadcast('thread.event', { threadId, event, seq })
      } else {
        push.broadcastRecordedEvent('thread.event', threadId, serializedEvent, seq)
      }
    },
    onSideEvent: (threadId, event, seq, serializedEvent) => {
      if (serializedEvent === undefined) {
        push.broadcast('sideChat.event', { threadId, event, seq })
      } else {
        push.broadcastRecordedEvent('sideChat.event', threadId, serializedEvent, seq)
      }
    },
    onQueue: (threadId, state) => push.broadcast('thread.queue', { threadId, ...state }),
    onLog: (line) => console.log(`[agent] ${line}`),
    onLogin: (provider, result) => push.broadcast('auth.event', { provider, ...result }),
    onMcpOAuth: (provider, projectPath, result) =>
      push.broadcast('mcp.oauth', { provider, projectPath, ...result }),
    onMcpChanged: (provider, projectPath) =>
      push.broadcast('mcp.changed', { provider, projectPath }),
    onSkillsChanged: (provider, projectPath) =>
      push.broadcast('skills.changed', { provider, projectPath }),
    onUsageChanged: (provider) => push.broadcast('usage.changed', { provider }),
    onLifecycle: (threadId, lifecycle) =>
      push.broadcast('thread.lifecycle', { threadId, lifecycle }),
    onLifecycleScheduleChanged: (hint) => notifyLifecycleScheduleChanged(hint),
    onTerminalOutput: (terminalId, data, outputOffset) =>
      push.broadcast('terminal.output', { terminalId, data, outputOffset }),
    onTerminalExit: (terminalId, exitCode) =>
      push.broadcast('terminal.exit', { terminalId, exitCode }),
    capturePreview: (url, viewports) =>
      previewCapture.available
        ? previewCapture.capture(url, viewports)
        : Promise.resolve(undefined),
  })
  reportStartupMilestone('server-orchestrator-ready')
  const checkpointProtection = orchestrator.protectStoredCheckpoints()
  const projectList = createProjectListProjector({
    includeDefaults: process.env['HARNESS_PROJECT_LIST_INCLUDE_DEFAULTS'] === '1',
  })
  const serializeProjectList = createSerializedResultCache()
  const historyResponse = createHistoryResponseProjector()
  const serializeHistory = createSerializedResultCache()
  const projectListState: ProjectListState = {
    isTurnRunning: (threadId) => orchestrator.isTurnRunning(threadId),
    inboxStatus: (threadId, queued, unread) => orchestrator.inboxStatus(threadId, queued, unread),
    revision: () => orchestrator.sidebarStatusRevision(),
    changesSince: (revision) => orchestrator.sidebarStatusChangesSince(revision),
  }
  const lifecycleScheduler = new LifecycleScheduler(
    () => orchestrator.refreshLifecycle(),
    () => store.nextLifecycleRefreshAt(),
  )
  notifyLifecycleScheduleChanged = (hint) => {
    if (hint === 'later') lifecycleScheduler.changedLater()
    else if (typeof hint === 'number') lifecycleScheduler.deadlineAdded(hint)
    else lifecycleScheduler.changed()
  }
  lifecycleScheduler.refreshNow()
  let historyClosing = false
  let historySessionStarts = 0
  const providerHistory = Promise.all([
    import('@harness/adapter-codex').then(({ createCodexHistorySource }) => ({
      provider: 'codex' as const,
      history: createCodexHistorySource(),
    })),
    import('@harness/adapter-claude-code').then(({ createClaudeHistorySource }) => ({
      provider: 'claude-code' as const,
      history: createClaudeHistorySource(),
    })),
    import('@harness/adapter-grok').then(({ createGrokHistorySource }) => ({
      provider: 'grok' as const,
      history: createGrokHistorySource(),
    })),
  ]).then(
    (sources) =>
      new ProviderHistory(store, sources, {
        isBusy: (threadId) => orchestrator.isTurnRunning(threadId),
        canImport: () => historySessionStarts === 0,
        changed: (threadIds) => {
          if (!historyClosing) {
            lifecycleScheduler.changed()
            push.broadcast('providerHistory.changed', { threadIds })
          }
        },
        log: (message) => console.log(`[history] ${message}`),
      }),
  )
  const refreshProviderHistory = () => {
    if (!historyClosing)
      void providerHistory.then((history) => history.refresh()).catch(() => undefined)
  }
  const providerHistoryTimer = setInterval(refreshProviderHistory, 15_000)
  providerHistoryTimer.unref()
  refreshProviderHistory()

  async function loadProviderHistory(threadId: string): Promise<void> {
    const history = await providerHistory
    if (await history.load(threadId)) orchestrator.invalidateImportedHistory(threadId)
  }
  // A previous run killed mid-session leaves git believing in checkouts that
  // are gone. Clearing that up at startup means the next session on that path
  // starts instead of failing with a message about our own leftovers.
  void orchestrator.recoverWorktrees().catch(() => undefined)

  wss.on('connection', (socket, request) => {
    if (!allowedOrigin(request.headers.origin, options.accessToken)) {
      socket.close(1008, 'Origin not allowed')
      return
    }
    if (!hasAccess(request.url, options.accessToken)) {
      socket.close(1008, 'Access denied')
      return
    }
    acceptConnection(socket)
  })

  function acceptConnection(socket: WebSocket): void {
    const welcome = {
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    }

    push.add(socket)
    push.send(socket, 'server.welcome', welcome)

    socket.on('message', (raw) =>
      handleMessage(socket, raw.toString()).catch((error) =>
        console.error(`[server] request handling failed: ${String(error)}`),
      ),
    )
    const removeSocket = () => {
      previewCapture.remove(socket)
      push.remove(socket)
    }
    socket.on('close', removeSocket)
    // Without a handler, a client resetting its connection emits 'error' on a
    // bare EventEmitter and crashes the whole server.
    socket.on('error', removeSocket)
  }

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    const envelope = parseRequestEnvelope(parsed)
    if (!envelope) {
      console.warn('[server] dropped malformed request')
      return
    }
    const { id, method, params } = envelope

    // hasOwn, not truthiness: `methods` is a plain object, so 'constructor',
    // 'toString' and friends pass a truthy check and then blow up on
    // spec.params — outside the try below, so no reply is ever sent and the
    // client's call hangs until the socket closes.
    if (!isMethodName(method)) {
      respondError(socket, id, ErrorCode.BAD_REQUEST, `unknown method: ${method}`)
      return
    }
    const createsSession = method === 'thread.start' || method === 'sideChat.start'
    if (createsSession) historySessionStarts += 1
    try {
      const result = await route(socket, method, params)
      if (socket.readyState === socket.OPEN) {
        push.reply(socket, serializeSuccessResponse(id, result))
        if (method === 'projects.list') reportStartupMilestone('server-projects-sent')
      }
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        respondError(socket, id, ErrorCode.BAD_REQUEST, error.message, error.detail)
        return
      }
      respondError(
        socket,
        id,
        error instanceof StaleDiffSnapshotError ? ErrorCode.STALE_SNAPSHOT : ErrorCode.INTERNAL,
        clientErrorMessage(error),
      )
    } finally {
      if (createsSession) historySessionStarts -= 1
    }
  }

  async function route(socket: WebSocket, method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case 'client.capabilities':
        previewCapture.setCapability(socket, parseParams(method, params).previewCapture)
        return {}

      case 'preview.captureResult':
        previewCapture.complete(socket, parseParams(method, params))
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
        return store.searchSessions(parseParams(method, params))

      case 'pullRequests.list': {
        const p = parseParams(method, params)
        return (await pullRequestService()).list(
          store.projects().map((project) => project.path),
          p.refresh ?? false,
        )
      }

      case 'pullRequests.setup': {
        const p = parseParams(method, params)
        const { githubSetupCommand } = await import('./pull-requests.js')
        const command = githubSetupCommand(p.action)
        return {
          terminalId:
            p.action === 'install'
              ? orchestrator.installProvider('github-cli', command, p.columns, p.rows)
              : orchestrator.launchProviderLogin('github-cli', command, p.columns, p.rows),
        }
      }

      case 'pullRequests.detail': {
        const p = parseParams(method, params)
        return (await pullRequestService()).detail(
          p.repository,
          p.number,
          store.projects().map((project) => project.path),
          p.refresh ?? false,
        )
      }

      case 'pullRequests.files': {
        const p = parseParams(method, params)
        return (await pullRequestService()).files(
          p.repository,
          p.number,
          p.page ?? 1,
          p.refresh ?? false,
        )
      }

      case 'pullRequests.metadataOptions': {
        const p = parseParams(method, params)
        return (await pullRequestService()).metadataOptions(p.repository, p.refresh ?? false)
      }

      case 'pullRequests.action': {
        const p = parseParams(method, params)
        return (await pullRequestService()).action(p.repository, p.number, p.action)
      }

      case 'pullRequests.image':
        return (await pullRequestService()).images.image(parseParams(method, params).url)

      case 'providers.list':
        return { providers: await (await providerService).detectProviders() }

      case 'providers.updates':
        return {
          updates: await (await providerUpdates()).list(parseParams(method, params).refresh),
        }

      case 'providers.update': {
        const p = parseParams(method, params)
        const command = await (await providerUpdates()).commandFor(p.provider)
        return {
          terminalId: orchestrator.installProvider(
            `update:${p.provider}`,
            command,
            p.columns,
            p.rows,
          ),
        }
      }

      case 'harnesses.list':
        return { harnesses: orchestrator.listCustomHarnesses() }

      case 'harnesses.upsert':
        return {
          harness: orchestrator.upsertCustomHarness(parseParams(method, params)),
        }

      case 'harnesses.verify': {
        const p = parseParams(method, params)
        return {
          verification: await orchestrator.verifyCustomHarness(p.harness, p.workspacePath),
        }
      }

      case 'harnesses.remove': {
        const p = parseParams(method, params)
        orchestrator.removeCustomHarness(p.harnessId)
        return {}
      }

      case 'providers.install': {
        const p = parseParams(method, params)
        const { installCommandFor } = await import('./providers.js')
        const command = await installCommandFor(p.provider, p.agent)
        const target = p.agent ? `${p.provider}:${p.agent}` : p.provider
        return { terminalId: orchestrator.installProvider(target, command, p.columns, p.rows) }
      }

      case 'providers.launch': {
        const p = parseParams(method, params)
        const { launchCommandFor } = await import('./providers.js')
        const command = await launchCommandFor(p.provider, p.agent)
        const target = p.agent ? `${p.provider}:${p.agent}` : p.provider
        return {
          terminalId: orchestrator.launchProviderLogin(target, command, p.columns, p.rows),
        }
      }

      case 'connections.list':
        return { connections: orchestrator.listModelConnections() }

      case 'connections.upsert':
        return {
          connection: orchestrator.upsertModelConnection(parseParams(method, params)),
        }

      case 'connections.setCredential': {
        const p = parseParams(method, params)
        orchestrator.setModelConnectionCredential(p.connectionId, p.apiKey)
        return { credentialConfigured: true }
      }

      case 'connections.remove': {
        const p = parseParams(method, params)
        orchestrator.removeModelConnection(p.connectionId)
        return {}
      }

      case 'connections.models': {
        const p = parseParams(method, params)
        return { models: await orchestrator.listConnectionModels(p.connectionId) }
      }

      case 'mcp.list': {
        const p = parseParams(method, params)
        return orchestrator.listMcpServers(p.provider, p.projectPath)
      }

      case 'mcp.add': {
        const p = parseParams(method, params)
        orchestrator.addMcpServer(p.provider, p.projectPath, p.server)
        return {}
      }

      case 'mcp.update': {
        const p = parseParams(method, params)
        orchestrator.updateMcpServer(p.provider, p.projectPath, p.server)
        return {}
      }

      case 'mcp.remove': {
        const p = parseParams(method, params)
        orchestrator.removeMcpServer(p.provider, p.projectPath, p.serverId)
        return {}
      }

      case 'mcp.reload': {
        const p = parseParams(method, params)
        await orchestrator.reloadMcpServers(p.provider, p.projectPath)
        return {}
      }

      case 'mcp.startOAuth': {
        const p = parseParams(method, params)
        return orchestrator.startMcpOAuth(p.provider, p.projectPath, p.serverId)
      }

      case 'mcp.cancelOAuth': {
        const p = parseParams(method, params)
        return orchestrator.cancelMcpOAuth(p.provider)
      }

      case 'skills.list': {
        const p = parseParams(method, params)
        return orchestrator.listSkills(p.provider, p.projectPath)
      }

      case 'skills.setEnabled': {
        const p = parseParams(method, params)
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
        const p = parseParams(method, params)
        return {
          skill: await orchestrator.installSkillFromFolder(p.provider, p.projectPath, p.folderPath),
        }
      }

      case 'auth.status': {
        const p = parseParams(method, params)
        return orchestrator.account(p.provider, p.agent)
      }

      case 'auth.startLogin': {
        const p = parseParams(method, params)
        return orchestrator.startLogin(p.provider)
      }

      case 'auth.cancelLogin': {
        const p = parseParams(method, params)
        await orchestrator.cancelLogin(p.provider, p.loginId)
        return {}
      }

      case 'auth.useApiKey': {
        const p = parseParams(method, params)
        return orchestrator.useApiKey(p.provider, p.apiKey)
      }

      case 'auth.signOut': {
        const p = parseParams(method, params)
        await orchestrator.signOut(p.provider, p.agent)
        return {}
      }

      case 'workspace.info': {
        const p = parseParams(method, params)
        return readWorkspace(resolveWorkspacePath(p.path))
      }

      case 'workspace.branches': {
        const p = parseParams(method, params)
        return { branches: await listWorkspaceBranches(resolveWorkspacePath(p.path)) }
      }

      case 'workspace.switchBranch': {
        const p = parseParams(method, params)
        return orchestrator.switchBranch(p.path, p.branch)
      }

      case 'workspace.diff': {
        const p = parseParams(method, params)
        return readWorkspaceDiff(workspaceForRequest(store, p))
      }

      case 'workspace.listDirectory': {
        const p = parseParams(method, params)
        return listWorkspaceDirectory(workspaceForRequest(store, p), p.directory)
      }

      case 'workspace.readFile': {
        const p = parseParams(method, params)
        return readWorkspaceTextFile(workspaceForRequest(store, p), p.path)
      }

      case 'models.list': {
        const p = parseParams(method, params)
        return { models: await orchestrator.listModels(p.provider, p.agent) }
      }

      case 'backgroundModel.settings':
        return orchestrator.backgroundModelSettings()

      case 'backgroundModel.updateSettings':
        return orchestrator.updateBackgroundModelPreference(parseParams(method, params))

      case 'backgroundModel.generateTitle': {
        const p = parseParams(method, params)
        return orchestrator.generateBackgroundTitle(p.threadId, p.prompt, p.expectedTitle)
      }

      case 'backgroundModel.generateCommitMessage': {
        const p = parseParams(method, params)
        const diff = await readWorkspaceDiff(workspaceForRequest(store, p))
        return { message: await orchestrator.generateBackgroundCommitMessage(diff) }
      }

      case 'voice.status': {
        const p = parseParams(method, params)
        return orchestrator.voiceStatus(p.provider)
      }

      case 'voice.transcribe':
        return orchestrator.transcribeVoice(parseParams(method, params))

      case 'voice.cancel': {
        const p = parseParams(method, params)
        orchestrator.cancelVoice(p.requestId)
        return {}
      }

      case 'acp.agents': {
        const agents = await (await import('@harness/adapter-acp/agents')).detectAgents()
        return {
          agents: agents.map(({ id, name, installed, verified, install, setup, problem }) => ({
            id,
            name,
            installed,
            verified,
            setup,
            ...(!(install === undefined) ? { install } : {}),
            ...(!(problem === undefined) ? { problem } : {}),
          })),
        }
      }

      case 'projects.list': {
        reportStartupMilestone('server-projects-requested')
        lifecycleScheduler.refreshIfDue()
        const projects = store.projects()
        const threads = store.sidebarThreads()
        const queuedThreadIds = store.queuedThreadIds()
        reportStartupMilestone('server-projects-store-ready')
        const projected = projectList(projects, threads, queuedThreadIds, projectListState)
        reportStartupMilestone('server-projects-projected')
        const serialized = serializeProjectList(projected)
        reportStartupMilestone('server-projects-serialized')
        return serialized
      }

      case 'projects.add': {
        const p = parseParams(method, params)
        const project = store.addProject(p.path, p.name)
        refreshProviderHistory()
        return project
      }

      case 'projects.pin': {
        const p = parseParams(method, params)
        store.setPinned(p.path, p.pinned)
        return {}
      }

      case 'projects.rename': {
        const p = parseParams(method, params)
        store.renameProject(p.path, p.name)
        return {}
      }

      case 'projects.remove': {
        const p = parseParams(method, params)
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
        await Promise.all(store.threads(p.path).map((thread) => orchestrator.close(thread.id)))
        orchestrator.forgetProject(p.path)
        store.removeProject(p.path)
        return {}
      }

      case 'terminal.open': {
        const p = parseParams(method, params)
        return {
          terminalId:
            'threadId' in p
              ? orchestrator.openTerminal(p.threadId, p.columns, p.rows, p.terminalKey)
              : orchestrator.openProjectTerminal(p.projectPath, p.columns, p.rows, p.terminalKey),
        }
      }

      case 'terminal.input': {
        const p = parseParams(method, params)
        orchestrator.writeTerminal(p.terminalId, p.data)
        return {}
      }

      case 'terminal.status': {
        const p = parseParams(method, params)
        return orchestrator.terminalStatus(p.terminalId)
      }

      case 'providers.watch': {
        const p = parseParams(method, params)
        return orchestrator.watchProvider(p.provider, p.projectPath, p.targets)
      }

      case 'terminal.resize': {
        const p = parseParams(method, params)
        orchestrator.resizeTerminal(p.terminalId, p.columns, p.rows)
        return {}
      }

      case 'terminal.close': {
        const p = parseParams(method, params)
        await orchestrator.closeTerminal(p.terminalId)
        return {}
      }

      case 'attachments.saveImage': {
        const p = parseParams(method, params)
        return {
          path: await materializeAttachment({ name: imageFileName(p.mimeType), data: p.data }),
        }
      }

      case 'thread.rename': {
        const p = parseParams(method, params)
        store.renameThread(p.threadId, p.title)
        return {}
      }

      case 'thread.pin': {
        const p = parseParams(method, params)
        store.setThreadPinned(p.threadId, p.pinned)
        return {}
      }

      case 'thread.settle': {
        const p = parseParams(method, params)
        return { lifecycle: orchestrator.settleThread(p.threadId) }
      }

      case 'thread.unsettle': {
        const p = parseParams(method, params)
        return { lifecycle: orchestrator.unsettleThread(p.threadId) }
      }

      case 'thread.snooze': {
        const p = parseParams(method, params)
        return { lifecycle: orchestrator.snoozeThread(p.threadId, p.wakeAt) }
      }

      case 'thread.unsnooze': {
        const p = parseParams(method, params)
        return { lifecycle: orchestrator.unsnoozeThread(p.threadId) }
      }

      case 'thread.setKeepActive': {
        const p = parseParams(method, params)
        return { lifecycle: orchestrator.setThreadKeepActive(p.threadId, p.keepActive) }
      }

      case 'thread.delete': {
        const p = parseParams(method, params)
        if (store.thread(p.threadId)?.worktreePath) {
          throw new Error('discard the isolated session checkout before deleting it')
        }
        await orchestrator.close(p.threadId)
        store.deleteThread(p.threadId)
        orchestrator.forgetDeletedThread(p.threadId)
        lifecycleScheduler.changed()
        return {}
      }

      case 'thread.history': {
        const p = parseParams(method, params)
        await loadProviderHistory(p.threadId)
        const reset =
          p.afterSeq !== undefined && store.providerHistoryChangedAfter(p.threadId, p.afterSeq)
        const history = await orchestrator.historyForResponse(
          p.threadId,
          reset ? 0 : (p.afterSeq ?? 0),
        )
        const running = orchestrator.isTurnRunning(p.threadId)
        const approval = store.threadApproval(p.threadId) ?? 'ask'
        const result = historyResponse(history.events, running, approval)
        orchestrator.markThreadRead(p.threadId)
        if (reset) return { ...result, reset: true }
        return serializeHistory(
          result,
          history.serializedEvents === undefined
            ? undefined
            : `{"events":${history.serializedEvents},"running":${String(running)},"approval":${JSON.stringify(approval)}}`,
        )
      }

      case 'thread.diff': {
        const p = parseParams(method, params)
        return orchestrator.diff(p.threadId)
      }

      case 'thread.undoTurnChanges': {
        const p = parseParams(method, params)
        await orchestrator.undoTurnChanges(p.threadId, p.turnId, p.expectedDiff)
        return {}
      }

      case 'thread.reviewHunk': {
        const p = parseParams(method, params)
        return {
          diff: await orchestrator.reviewHunk(p.threadId, p.version, p.path, p.hunkId, p.decision),
        }
      }

      case 'thread.reviewFile': {
        const p = parseParams(method, params)
        return {
          diff: await orchestrator.reviewFile(p.threadId, p.version, p.path, p.decision),
        }
      }

      case 'usage.summary': {
        const p = parseParams(method, params)
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
        const totals =
          'threadId' in p
            ? store.usageSummary(p.threadId, startOfToday.getTime())
            : { session: empty, today: empty }
        return usageSummaryWithLimits(totals, provider, (requestedProvider) =>
          orchestrator.usageLimitSource(requestedProvider),
        )
      }

      case 'usage.consumeReset': {
        const p = parseParams(method, params)
        return orchestrator.consumeRateLimitReset(p.provider, p.idempotencyKey, p.creditId)
      }

      case 'sideChat.start': {
        const p = parseParams(method, params)
        const thread = await orchestrator.startSideThread(p.parentThreadId, {
          model: p.model,
          serviceTier: p.serviceTier,
          effort: p.effort,
          approval: p.approval,
        })
        return { threadId: thread.id }
      }

      case 'sideChat.close': {
        const p = parseParams(method, params)
        await orchestrator.closeSideThread(p.threadId)
        return {}
      }

      case 'thread.start': {
        const p = parseParams(method, params)
        const thread = await orchestrator.startThread(p.provider, p.workspacePath, {
          baseRef: p.baseRef,
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
        const p = parseParams(method, params)
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
        const p = parseParams(method, params)
        return { files: await orchestrator.changedSinceCheckpoint(p.threadId, p.checkpointId) }
      }

      case 'thread.restore': {
        const p = parseParams(method, params)
        return orchestrator.restoreCheckpoint(p.threadId, p.checkpointId)
      }

      case 'thread.undoRestore': {
        const p = parseParams(method, params)
        await orchestrator.undoRestore(p.threadId, p.undo)
        return {}
      }

      case 'thread.unsavedWork': {
        const p = parseParams(method, params)
        const stored = store.thread(p.threadId)
        return {
          isolated: stored?.worktreePath !== undefined,
          uncommitted: await orchestrator.hasUnsavedWork(p.threadId),
        }
      }

      case 'thread.discardWorktree': {
        const p = parseParams(method, params)
        await orchestrator.discardWorktree(p.threadId, p.force ?? false)
        return {}
      }

      case 'thread.sendTurn': {
        const p = parseParams(method, params)
        await loadProviderHistory(p.threadId)
        return {
          ...(await orchestrator.submitTurn(
            p.threadId,
            p.text,
            p.attachments,
            {
              model: p.model,
              effort: p.effort,
              serviceTier: p.serviceTier,
            },
            p.clientSubmissionId,
          )),
        }
      }

      case 'thread.queue': {
        const p = parseParams(method, params)
        return orchestrator.queue(p.threadId)
      }

      case 'thread.deleteQueuedTurn': {
        const p = parseParams(method, params)
        orchestrator.deleteQueuedTurn(p.threadId, p.queuedTurnId)
        return {}
      }

      case 'thread.moveQueuedTurn': {
        const p = parseParams(method, params)
        orchestrator.moveQueuedTurn(p.threadId, p.queuedTurnId, p.direction)
        return {}
      }

      case 'thread.steerQueuedTurn': {
        const p = parseParams(method, params)
        await orchestrator.steerQueuedTurn(p.threadId, p.queuedTurnId)
        return {}
      }

      case 'thread.respondToApproval': {
        const p = parseParams(method, params)
        orchestrator.respondToApproval(p.threadId, p.approvalId, p.decision)
        return {}
      }

      case 'thread.respondToUserInput': {
        const p = parseParams(method, params)
        orchestrator.respondToUserInput(p.threadId, p.requestId, p.answers)
        return {}
      }

      case 'thread.interrupt': {
        const p = parseParams(method, params)
        await orchestrator.interrupt(p.threadId)
        return {}
      }

      case 'thread.setApproval': {
        const p = parseParams(method, params)
        await orchestrator.setThreadApproval(p.threadId, p.approval)
        return {}
      }

      case 'thread.close': {
        const p = parseParams(method, params)
        await orchestrator.close(p.threadId)
        return {}
      }

      case 'sidebar.settings':
        return store.sidebarSettings()

      case 'sidebar.updateSettings': {
        const update = parseParams(method, params)
        const settings = store.updateSidebarSettings({
          ...(update.mode ? { mode: update.mode } : {}),
          ...(update.autoSettleDays === undefined ? {} : { autoSettleDays: update.autoSettleDays }),
        })
        push.broadcast('sidebar.settings', settings)
        lifecycleScheduler.refreshNow()
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
    push.reply(
      socket,
      JSON.stringify({
        id,
        error: { code, message, ...(detail ? { detail } : {}) },
      }),
    )
  }

  console.log(`[server] listening on ws://${host}:${port}`)

  return {
    port,
    close: async () => {
      historyClosing = true
      clearInterval(providerHistoryTimer)
      await providerHistory.then((history) => history.close()).catch(() => undefined)
      lifecycleScheduler.dispose()
      const orchestratorClosed = orchestrator.disposeAll()
      for (const socket of wss.clients) socket.terminate()
      const results = await Promise.allSettled([
        orchestratorClosed,
        checkpointProtection,
        new Promise<void>((resolve) => wss.close(() => resolve())),
      ])
      try {
        store.close()
      } finally {
        releaseDataLease()
      }
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
 * Allowed: no Origin at all (non-browser clients such as the CLI and tests),
 * `file://` (the packaged Electron renderer), and loopback origins (the dev
 * server and our own web UI).
 *
 * `null` is NOT allowed, and must never be added back. It is the opaque
 * origin, and any page can mint one on demand — `<iframe sandbox=
 * "allow-scripts" srcdoc=…>` or a `data:` document — so allowing it hands the
 * gate straight back to the attacker it exists to stop. If a renderer of ours
 * ever reports an opaque origin, the answer is an access token for that
 * surface, not a hole here.
 *
 * When the server deliberately binds beyond loopback, an access token is
 * mandatory (see assertSafeBind), and that token becomes the trust boundary:
 * any origin may attempt the handshake, but only a connection carrying the
 * token is admitted.
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

function workspaceForRequest(
  store: Store,
  request: { projectPath: string; threadId?: string | undefined },
): string {
  const project = store.projects().find((entry) => entry.path === request.projectPath)
  if (!project) throw new Error('project is not registered')
  if (!request.threadId) return resolveWorkspacePath(project.path)

  const thread = store.thread(request.threadId)
  if (!thread || thread.projectPath !== project.path)
    throw new Error('thread is not in this project')
  return resolveWorkspacePath(thread.worktreePath ?? project.path)
}

function isMethodName(method: string): method is MethodName {
  return Object.hasOwn(methods, method)
}

type MethodParams<M extends MethodName> = ReturnType<(typeof methods)[M]['params']['parse']>

class InvalidParamsError extends Error {
  constructor(
    method: MethodName,
    readonly detail?: string,
  ) {
    super(`invalid params for ${method}`)
  }
}

function parseParams<M extends MethodName>(method: M, params: unknown): MethodParams<M> {
  if (method === 'terminal.input' || method === 'terminal.resize') {
    const frequent = parseFrequentMethodParams(method, params)
    if (frequent) return frequent as MethodParams<M>
  }
  const decoded = methods[method].params.safeParse(params)
  if (!decoded.success) {
    const first = decoded.error.issues[0]
    throw new InvalidParamsError(
      method,
      first ? `${first.path.join('.') || '(root)'}: ${first.message}` : undefined,
    )
  }
  // The same generic key selects the runtime schema and its indexed output type.
  return decoded.data as MethodParams<M>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function clientErrorMessage(error: unknown): string {
  if (errorCode(error) === 'ENOENT') {
    if (
      typeof error === 'object' &&
      error !== null &&
      'syscall' in error &&
      typeof error.syscall === 'string' &&
      error.syscall.startsWith('spawn ')
    ) {
      return 'A required program could not be started. Check the provider installation and executable search path.'
    }
    return 'This project folder or workspace item is unavailable. Choose another project or add the folder again.'
  }
  return messageOf(error)
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
