import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  DEFAULT_ACCOUNT_ID,
  ErrorCode,
  methods,
  PROTOCOL_VERSION,
  type MethodName,
  type ProviderHistorySource,
  type ProviderId,
  type ProviderStatus,
} from '@harness/contracts'
import { applyDesktopPath } from '@harness/proc/desktop-path'
import { cliProbe, invalidateCliProbes } from './cli-probe.js'
import { stopModelListings } from './runtime-loader.js'
import { readWorkspaceDiff, StaleDiffSnapshotError } from './diff-review.js'
import { Orchestrator, resolveWorkspacePath, type LifecycleScheduleHint } from './orchestrator.js'
import { checkForUpdates } from './update-check.js'
import type { FeedbackConfig } from './feedback-config.js'
import { FeedbackService, providerVersionLabel } from './feedback.js'
import { PushBus } from './push-bus.js'
import { storeLocation } from './data-location.js'
import { acquireDataLease } from './data-lease.js'
import { PreviewCaptureCoordinator } from './preview-capture.js'
import type { CheckoutPullRequests } from './checkout-pull-request.js'
import type { PullRequestService } from './pull-requests.js'
import { sourceAccount } from './account-directory.js'
import { ProviderAccounts } from './provider-accounts.js'
import { DEFAULT_PORT } from './server-config.js'
import { Store } from './store.js'
import { createProjectListProjector, type ProjectListState } from './project-list.js'
import { imageFileName, materializeAttachment } from './uploaded-attachment.js'
import type { UsageHistoryService } from './usage-history.js'
import { usageSummaryWithLimits } from './usage-summary.js'
import { listWorkspaceBranches, readWorkspace } from './workspace.js'
import { commitCheckout, pushCheckout } from './workspace-git.js'
import {
  listWorkspaceDirectory,
  readWorkspaceTextFile,
  searchWorkspaceFiles,
} from './workspace-files.js'
import { LifecycleScheduler } from './lifecycle-scheduler.js'
import { parseFrequentMethodParams, parseRequestEnvelope } from './request-envelope.js'
import { createHistoryResponseProjector } from './history-response.js'
import { InvalidHistoryCursorError } from './history-page.js'
import { createSerializedResultCache, serializeSuccessResponse } from './response-serializer.js'
import { ProviderHistory } from './provider-history.js'
import { HistoryRefreshSchedule } from './history-refresh-schedule.js'
import { STREAM_QUIET_BACKGROUND_WAIT_MS, StreamQuiet } from './stream-quiet.js'

const SERVER_VERSION = '0.0.0'
const DEFAULT_RENDERER_ORIGIN = 'http://127.0.0.1:5183'
/** When no client has asked for its projects by then, background work starts anyway. */
const BACKGROUND_WORK_DELAY_MS = 1_500
/**
 * Reads of provider state that may load an adapter or start a vendor CLI on
 * first use. The desktop's Node (24) loads and compiles an imported module
 * graph synchronously inside `import()`, so the first of these held the event
 * loop for 0.2 to 0.6 s while the renderer's first batch was handled, and the
 * store reads behind it in that batch (the project list among them) waited as
 * long. They start one turn later, once the replies to the rest of their batch
 * went out. None of them changes what a store read answers.
 */
const PROVIDER_READS: ReadonlySet<MethodName> = new Set<MethodName>([
  'acp.agents',
  'auth.status',
  'commands.list',
  'mcp.list',
  'models.list',
  'providers.list',
  'providers.updates',
  'skills.list',
  'usage.history',
  'usage.summary',
  'voice.status',
])
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
    rendererOrigin?: string
    /** Resolved by the entry point, which also removes it from the environment. */
    feedback?: FeedbackConfig
  } = {},
) {
  applyDesktopPath()
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  const rendererOrigin =
    options.rendererOrigin ?? process.env['HARNESS_RENDERER_ORIGIN'] ?? DEFAULT_RENDERER_ORIGIN
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
  const accounts = new ProviderAccounts(store, {
    root: path.join(path.dirname(databasePath), 'accounts'),
    onChanged: (provider) => push.broadcast('accounts.changed', { provider }),
  })

  // Install, update and sign-in terminals can add, replace or update a CLI.
  const setupTerminals = new Set<string>()
  const setupTerminal = (terminalId: string) => {
    setupTerminals.add(terminalId)
    return terminalId
  }
  const providerService = import('./providers.js')
  let updatesService: Promise<import('./provider-updates.js').ProviderUpdateService> | undefined
  const providerUpdates = () =>
    (updatesService ??= import('./provider-updates.js').then(
      ({ ProviderUpdateService }) => new ProviderUpdateService(),
    ))
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
  let checkoutPullRequests: Promise<CheckoutPullRequests> | undefined
  const checkoutPullRequestService = () =>
    (checkoutPullRequests ??= Promise.all([
      pullRequestService(),
      import('./checkout-pull-request.js'),
    ]).then(
      ([service, { CheckoutPullRequests }]) =>
        new CheckoutPullRequests({ account: (refresh) => service.account(refresh) }),
    ))
  /** The checkout's pull request may have changed on GitHub. */
  const checkoutChanged = (checkout: string) => {
    void checkoutPullRequests?.then(
      (service) => service.invalidateCheckout(checkout),
      () => {},
    )
  }
  /** A finished turn may have pushed or opened a pull request from its checkout. */
  const turnEndedInCheckout = (threadId: string) => {
    if (!checkoutPullRequests) return
    const thread = store.thread(threadId)
    if (!thread) return
    checkoutChanged(resolveWorkspacePath(thread.worktreePath ?? thread.projectPath))
  }
  let notifyLifecycleScheduleChanged: (hint?: LifecycleScheduleHint) => void = () => {}
  let usageHistory: Promise<UsageHistoryService> | undefined
  let usageHistoryClosing = false
  const usageHistoryService = () =>
    (usageHistory ??= import('./usage-history.js').then(({ UsageHistoryService }) => {
      const service = new UsageHistoryService({
        cacheFile: path.join(path.dirname(databasePath), 'usage-history.json'),
        // Every other provider account keeps its history in its own folder.
        accountHomes: () => {
          const { accounts: listed } = accounts.list()
          return listed.flatMap(({ provider, id, home }) =>
            home === undefined || id === DEFAULT_ACCOUNT_ID
              ? []
              : [{ provider, accountId: id, home }],
          )
        },
        harnessUsage: () => store.usageEvents(),
      })
      if (usageHistoryClosing) service.dispose()
      else void service.startBackgroundRefresh()
      return service
    }))
  const streamQuiet = new StreamQuiet()
  cliProbe.waitBeforeReads(() => streamQuiet.whenQuiet(STREAM_QUIET_BACKGROUND_WAIT_MS))
  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event, seq, serializedEvent) => {
      if (event.type === 'item.delta') streamQuiet.noteDelta()
      else if (event.type === 'turn.completed') turnEndedInCheckout(threadId)
      if (serializedEvent === undefined) {
        push.broadcast('thread.event', { threadId, event, seq })
      } else {
        push.broadcastRecordedEvent('thread.event', threadId, serializedEvent, seq)
      }
    },
    onSideEvent: (threadId, event, seq, serializedEvent) => {
      if (event.type === 'item.delta') streamQuiet.noteDelta()
      if (serializedEvent === undefined) {
        push.broadcast('sideChat.event', { threadId, event, seq })
      } else {
        push.broadcastRecordedEvent('sideChat.event', threadId, serializedEvent, seq)
      }
    },
    onQueue: (threadId, state) => push.broadcast('thread.queue', { threadId, ...state }),
    onLog: (line) => console.log(`[agent] ${line}`),
    onLogin: (provider, result, accountId) => {
      push.broadcast('auth.event', { provider, ...(accountId ? { accountId } : {}), ...result })
      // Whoever just signed in is that account's identity from now on.
      if (result.success && accounts.supports(provider)) {
        void orchestrator
          .account(provider, undefined, accountId)
          .then((account) => accounts.recordIdentity(provider, accountId, account))
          .catch(() => undefined)
      }
    },
    onMcpOAuth: (provider, projectPath, result) =>
      push.broadcast('mcp.oauth', { provider, projectPath, ...result }),
    onMcpChanged: (provider, projectPath) =>
      push.broadcast('mcp.changed', { provider, projectPath }),
    onSkillsChanged: (provider, projectPath) =>
      push.broadcast('skills.changed', { provider, projectPath }),
    onCommandsChanged: (provider, projectPath) =>
      push.broadcast('commands.changed', { provider, projectPath }),
    onUsageChanged: (provider, accountId) =>
      push.broadcast('usage.changed', accountId ? { provider, accountId } : { provider }),
    onLimitsChanged: (source) => push.broadcast('usage.limits', { source }),
    providerBinary: async (provider) => (await providerService).providerBinary(provider),
    onModelsChanged: (provider, agent, accountId) =>
      push.broadcast('models.changed', {
        provider,
        ...(agent === undefined ? {} : { agent }),
        ...(accountId ? { accountId } : {}),
      }),
    onLifecycle: (threadId, lifecycle) =>
      push.broadcast('thread.lifecycle', { threadId, lifecycle }),
    onLifecycleScheduleChanged: (hint) => notifyLifecycleScheduleChanged(hint),
    onTerminalOutput: (terminalId, data, outputOffset) =>
      push.broadcast('terminal.output', { terminalId, data, outputOffset }),
    onTerminalExit: (terminalId, exitCode) => {
      // Before the exit reaches a client, which re-lists providers right away.
      if (setupTerminals.delete(terminalId)) invalidateCliProbes()
      push.broadcast('terminal.exit', { terminalId, exitCode })
    },
    capturePreview: (url, viewports, signal) =>
      previewCapture.available
        ? previewCapture.capture(url, viewports, signal)
        : Promise.resolve(undefined),
    // A preview on the control port or the trusted renderer's port would pass
    // the Origin check whenever nothing else holds that port.
    reservedPreviewPorts: new Set([port, ...httpOriginPort(rendererOrigin)]),
    beforeLimitRead: () => streamQuiet.whenQuiet(),
    accounts,
  })
  reportStartupMilestone('server-orchestrator-ready')
  let providerStatuses: readonly ProviderStatus[] = []
  const feedback = new FeedbackService({
    config: options.feedback,
    ledger: {
      read: () => store.feedbackLedger(),
      write: (value) => store.setFeedbackLedger(value),
    },
    appVersion: process.env['HARNESS_APP_VERSION'],
    knownPaths: (threadId) => {
      const thread = threadId ? store.thread(threadId) : undefined
      return [
        ...store.projects().map((project) => project.path),
        ...(thread?.worktreePath ? [thread.worktreePath] : []),
      ]
    },
    providerLabel: (provider) => {
      const status = providerStatuses.find((entry) => entry.id === provider)
      return status ? providerVersionLabel(status.displayName, status.version) : undefined
    },
  })
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
  // Each provider's saved chats load on their own: an adapter that cannot be
  // loaded must not keep local chats, or another provider's, from opening.
  const historySources = [
    {
      provider: 'codex',
      load: async () => (await import('@harness/adapter-codex')).createCodexHistorySource(),
    },
    {
      provider: 'claude-code',
      load: async () => (await import('@harness/adapter-claude-code')).createClaudeHistorySource(),
    },
    {
      provider: 'grok',
      load: async () => (await import('@harness/adapter-grok')).createGrokHistorySource(),
    },
  ] satisfies Array<{ provider: ProviderId; load(): Promise<ProviderHistorySource> }>
  /** Why a source failed to load, keyed by the id prefix of the chats it imports. */
  const unavailableHistory = new Map<string, unknown>()
  const loadHistoryService = () =>
    Promise.allSettled(historySources.map(({ load }) => load())).then(
      (results) =>
        new ProviderHistory(
          store,
          historySources.flatMap(({ provider }, index) => {
            const result = results[index]!
            if (result.status === 'fulfilled') return [{ provider, history: result.value }]
            unavailableHistory.set(`external:${provider}:`, result.reason)
            console.log(`[history] ${provider} history could not be loaded`)
            return []
          }),
          {
            isBusy: (threadId) => orchestrator.isTurnRunning(threadId),
            canImport: () => historySessionStarts === 0,
            changed: (threadIds) => {
              if (!historyClosing) {
                lifecycleScheduler.changed()
                push.broadcast('providerHistory.changed', { threadIds })
              }
            },
            log: (message) => console.log(`[history] ${message}`),
          },
        ),
    )
  /** Set once background work starts; see startBackgroundWork. */
  let providerHistory: Promise<ProviderHistory> | undefined
  /** The same service once it exists, for checks that must not wait for it. */
  let providerHistoryReady: ProviderHistory | undefined
  /**
   * Chats this server run started. Their provider sessions began after the
   * launch, so until a scan links one to its saved session there are no turns
   * taken outside TasteCode to merge, and a turn need not wait for the scan.
   */
  const startedThisRun = new Set<string>()
  const historySchedule = new HistoryRefreshSchedule(async () => {
    if (historyClosing || !providerHistory) return false
    // A timed refresh can read an index for hundreds of milliseconds; not mid-stream.
    await streamQuiet.whenQuiet(STREAM_QUIET_BACKGROUND_WAIT_MS)
    return historyClosing ? false : (await providerHistory).refresh()
  })
  const refreshProviderHistory = () => {
    // Before background work starts, its first scan will pick the change up.
    if (historyClosing) return
    historySchedule.activity()
    void providerHistory?.then((history) => history.refresh()).catch(() => undefined)
  }
  // That first scan reads every saved provider session and can take seconds
  // (about 10 s on a large ~/.claude). A native chat's transcript is already
  // in the store, so reading it does not wait: the import a read would have
  // run is queued here, runs once the scan is done, and announces a changed
  // chat so open clients reload it.
  let initialProviderHistorySettled = false
  const importsAfterInitialScan = new Set<string>()

  function startProviderHistory(): void {
    const service = loadHistoryService()
    providerHistory = service
    // Opening a task during startup must not replay an obsolete imported transcript
    // before adapter revisions and ownership have been refreshed.
    const initial = service.then(async (history) => {
      providerHistoryReady = history
      await history.refresh()
      return history
    })
    historySchedule.start()
    void initial
      .then(async (history) => {
        initialProviderHistorySettled = true
        const changed: string[] = []
        for (const threadId of importsAfterInitialScan) {
          importsAfterInitialScan.delete(threadId)
          try {
            if (await history.load(threadId)) {
              orchestrator.invalidateImportedHistory(threadId)
              changed.push(threadId)
            }
          } catch {
            // The chat's next read or turn retries the import.
          }
        }
        if (changed.length && !historyClosing) {
          lifecycleScheduler.changed()
          push.broadcast('providerHistory.changed', { threadIds: changed })
        }
      })
      .catch(() => {
        initialProviderHistorySettled = true
        importsAfterInitialScan.clear()
      })
  }

  // Background startup work starts CLIs for their versions, reads the Windows
  // PATH from the registry, scans every saved provider session and recovers
  // worktrees. Much of it holds the event loop for seconds (a Codex index read,
  // version probes, adapter modules loading), and the renderer's first
  // requests waited behind all of it. It now starts once the first client has
  // its project list, or shortly after listening when no client comes.
  let backgroundStarted = false
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined
  wss.once('listening', () => {
    if (backgroundStarted || historyClosing) return
    backgroundTimer = setTimeout(startBackgroundWork, BACKGROUND_WORK_DELAY_MS)
    backgroundTimer.unref()
  })
  function startBackgroundWork(): void {
    if (backgroundStarted || historyClosing) return
    backgroundStarted = true
    clearTimeout(backgroundTimer)
    void providerService.then(({ prewarmProviders }) => prewarmProviders()).catch(() => undefined)
    startProviderHistory()
    // A previous run killed mid-session leaves git believing in checkouts that
    // are gone. Clearing that up at startup means the next session on that path
    // starts instead of failing with a message about our own leftovers.
    void orchestrator.recoverWorktrees().catch(() => undefined)
  }

  /** Import outside changes before a history read, without holding a native chat on the first scan. */
  async function loadProviderHistoryForRead(threadId: string): Promise<void> {
    if (!initialProviderHistorySettled && !threadId.startsWith('external:')) {
      importsAfterInitialScan.add(threadId)
      return
    }
    await loadProviderHistory(threadId)
  }

  async function loadProviderHistory(threadId: string): Promise<void> {
    // An imported chat or a turn needs the scan now, not after the start delay.
    startBackgroundWork()
    historySchedule.activity()
    // A first scan of a large history took minutes, and a new chat's first
    // message waited for it although it had nothing to merge.
    if (startedThisRun.has(threadId) && !providerHistoryReady?.hasCopy(threadId)) return
    let history: ProviderHistory
    try {
      if (!providerHistory) throw new Error('Provider history is closed')
      history = await providerHistory
    } catch (error) {
      // Only an imported chat depends on the history service for its transcript.
      if (threadId.startsWith('external:')) throw error
      return
    }
    for (const [prefix, reason] of unavailableHistory) {
      if (threadId.startsWith(prefix)) throw reason
    }
    // Revisions and ownership must be fresh before a read or turn, but only for
    // the chat's own provider: a turn waited for every provider's first scan,
    // which took 30-180 s on a large Claude history.
    const provider = historyProvider(threadId)
    if (provider) await history.scanned(provider)
    if (await history.load(threadId)) orchestrator.invalidateImportedHistory(threadId)
  }

  function historyProvider(threadId: string): ProviderId | undefined {
    const imported = /^external:([^:]+):/.exec(threadId)?.[1]
    if (imported === undefined) return store.thread(threadId)?.provider
    return historySources.find(({ provider }) => provider === imported)?.provider
  }

  wss.on('connection', (socket, request) => {
    // Rejected sockets remain live until their close handshake ends. Handle
    // protocol errors before either access check so they cannot crash the server.
    socket.on('error', () => socket.terminate())
    if (!allowedOrigin(request.headers.origin, options.accessToken, rendererOrigin)) {
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
    // Store reads that arrived in the same batch answer first; see PROVIDER_READS.
    if (PROVIDER_READS.has(method)) await new Promise<void>((resolve) => setImmediate(resolve))
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
      if (error instanceof UnknownMethodError) {
        respondError(socket, id, ErrorCode.BAD_REQUEST, error.message)
        return
      }
      if (error instanceof InvalidHistoryCursorError) {
        respondError(socket, id, ErrorCode.BAD_REQUEST, error.message)
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
      // One turn of the event loop first, so the answer leaves before the work starts.
      if (method === 'projects.list' && !backgroundStarted) setImmediate(startBackgroundWork)
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

      case 'feedback.status':
        return feedback.status()

      case 'feedback.preview':
        return feedback.preview(parseParams(method, params))

      case 'feedback.submit':
        return feedback.submit(parseParams(method, params))

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
          terminalId: setupTerminal(
            p.action === 'install'
              ? orchestrator.installProvider('github-cli', command, p.columns, p.rows)
              : orchestrator.launchProviderLogin('github-cli', command, p.columns, p.rows),
          ),
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
          { headRefOid: p.expectedHeadOid, baseRefOid: p.expectedBaseOid },
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
        try {
          return await (await pullRequestService()).action(p.repository, p.number, p.action)
        } finally {
          // Even a failed action may have changed the pull request on GitHub.
          void checkoutPullRequests?.then(
            (service) => service.invalidateRepository(p.repository),
            () => {},
          )
        }
      }

      case 'pullRequests.forCheckout': {
        const p = parseParams(method, params)
        const checkout = workspaceForRequest(store, p)
        return (await checkoutPullRequestService()).forCheckout(checkout, p.refresh ?? false)
      }

      case 'pullRequests.create': {
        const p = parseParams(method, params)
        const checkout = workspaceForRequest(store, p)
        return (await checkoutPullRequestService()).create(checkout, p)
      }

      case 'pullRequests.image':
        return (await pullRequestService()).images.image(parseParams(method, params).url)

      case 'providers.list': {
        const providers = await (await providerService).detectProviders()
        providerStatuses = providers
        return { providers }
      }

      case 'providers.contextSettings':
        return orchestrator.contextSettings()

      case 'providers.updateContextSettings': {
        const p = parseParams(method, params)
        return orchestrator.updateContextSettings(p.provider, p.settings)
      }

      case 'providers.accountContextSettings':
        parseParams(method, params)
        return { accounts: [...orchestrator.accountContextSettings()] }

      case 'providers.updateAccountContextSettings':
        return {
          accounts: [...orchestrator.updateAccountContextSettings(parseParams(method, params))],
        }

      case 'providers.updates':
        return {
          updates: await (await providerUpdates()).list(parseParams(method, params).refresh),
        }

      case 'providers.update': {
        const p = parseParams(method, params)
        const command = await (await providerUpdates()).commandFor(p.provider)
        return {
          terminalId: setupTerminal(
            orchestrator.installProvider(`update:${p.provider}`, command, p.columns, p.rows),
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
        return {
          terminalId: setupTerminal(
            orchestrator.installProvider(target, command, p.columns, p.rows),
          ),
        }
      }

      case 'providers.launch': {
        const p = parseParams(method, params)
        // The CLI signs in as the account in its folder; a custom harness has no other.
        const accountId = sourceAccount(p.agent, p.accountId)
        const environment = accounts.environment(p.provider, accountId)
        const { launchCommandFor } = await import('./providers.js')
        const command = await launchCommandFor(p.provider, p.agent)
        const target = p.agent ? `${p.provider}:${p.agent}` : p.provider
        const account =
          accountId === undefined || accountId === DEFAULT_ACCOUNT_ID
            ? undefined
            : { id: accountId, environment }
        return {
          terminalId: setupTerminal(
            orchestrator.launchProviderLogin(target, command, p.columns, p.rows, account),
          ),
        }
      }

      case 'mcp.list': {
        const p = parseParams(method, params)
        return orchestrator.listMcpServers(p.provider, p.projectPath)
      }

      case 'commands.list': {
        const p = parseParams(method, params)
        return orchestrator.listCommands(p.provider, p.projectPath, p.threadId)
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
        const account = await orchestrator.account(p.provider, p.agent, p.accountId)
        // A custom harness may sign in as someone else; only the CLI's own check names the account.
        if (p.agent === undefined) accounts.recordIdentity(p.provider, p.accountId, account)
        return account
      }

      case 'auth.startLogin': {
        const p = parseParams(method, params)
        return orchestrator.startLogin(p.provider, p.accountId)
      }

      case 'auth.cancelLogin': {
        const p = parseParams(method, params)
        await orchestrator.cancelLogin(p.provider, p.loginId, p.accountId)
        return {}
      }

      case 'auth.useApiKey': {
        const p = parseParams(method, params)
        const account = await orchestrator.useApiKey(p.provider, p.apiKey, p.accountId)
        accounts.recordIdentity(p.provider, p.accountId, account)
        return account
      }

      case 'auth.signOut': {
        const p = parseParams(method, params)
        await orchestrator.signOut(p.provider, p.agent, p.accountId)
        return {}
      }

      case 'accounts.list':
        return accounts.list(parseParams(method, params).provider)

      case 'accounts.detect':
        parseParams(method, params)
        return { found: accounts.detect() }

      case 'accounts.create': {
        const p = parseParams(method, params)
        const account = accounts.create(p.provider, p.label, p.home)
        // A folder the user brought may already hold a sign-in. Ask it once who
        // that is, as after a sign-in, so the account does not read as signed
        // out until someone signs in there again. A new folder holds none.
        if (!account.managed) {
          void orchestrator
            .account(p.provider, undefined, account.id)
            .then((read) => accounts.recordIdentity(p.provider, account.id, read))
            .catch(() => undefined)
        }
        return { account }
      }

      case 'accounts.rename': {
        const p = parseParams(method, params)
        return { account: accounts.rename(p.provider, p.accountId, p.label) }
      }

      case 'accounts.remove': {
        const p = parseParams(method, params)
        // Refused before anything stops: the default account, a gone one, a brought folder to delete.
        const removal = accounts.removal(p.provider, p.accountId, p.deleteHome ?? false)
        // Refused while a chat on it works. Otherwise the account stops resolving
        // first, so nothing new starts in its folder; then what runs as it stops
        // (Windows would not let the folder go), and the folder is deleted last.
        await orchestrator.releaseAccount(p.provider, p.accountId, removal.unregister)
        await removal.deleteFolder()
        return {}
      }

      case 'accounts.setActive': {
        const p = parseParams(method, params)
        accounts.setActive(p.provider, p.accountId)
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

      case 'workspace.commit': {
        const p = parseParams(method, params)
        const checkout = workspaceForRequest(store, p)
        return orchestrator.whileCheckoutIdle(checkout, () =>
          commitCheckout(checkout, { message: p.message, includeUntracked: p.includeUntracked }),
        )
      }

      case 'workspace.push': {
        const p = parseParams(method, params)
        const checkout = workspaceForRequest(store, p)
        try {
          return await pushCheckout(checkout)
        } finally {
          // New commits on a pull request's head restart its checks.
          checkoutChanged(checkout)
        }
      }

      case 'workspace.listDirectory': {
        const p = parseParams(method, params)
        return listWorkspaceDirectory(workspaceForRequest(store, p), p.directory)
      }

      case 'workspace.searchFiles': {
        const p = parseParams(method, params)
        return searchWorkspaceFiles(workspaceForRequest(store, p), p.query, p.limit)
      }

      case 'workspace.readFile': {
        const p = parseParams(method, params)
        return readWorkspaceTextFile(workspaceForRequest(store, p), p.path)
      }

      case 'models.list': {
        const p = parseParams(method, params)
        return { models: await orchestrator.listModels(p.provider, p.agent, p.accountId) }
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
        return { message: await orchestrator.generateBackgroundCommitMessage(diff, p.threadId) }
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
        const { acpCanSignOut, detectAgents } = await import('@harness/adapter-acp/agents')
        const agents = await detectAgents()
        return {
          agents: agents.map((agent) => {
            const { id, name, installed, verified, install, setup, problem, maker } = agent
            return {
              id,
              name,
              installed,
              verified,
              setup,
              signOut: acpCanSignOut(agent),
              ...(!(install === undefined) ? { install } : {}),
              ...(!(problem === undefined) ? { problem } : {}),
              ...(!(maker === undefined) ? { maker } : {}),
            }
          }),
        }
      }

      case 'projects.list': {
        reportStartupMilestone('server-projects-requested')
        historySchedule.activity()
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
        // when the project is added again. Running processes still need an
        // owner, so stop them — but do not archive the chats, or none of them
        // could be continued after the project is added back.
        await Promise.all(store.threads(p.path).map((thread) => orchestrator.stopThread(thread.id)))
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
        historySchedule.activity()
        await loadProviderHistoryForRead(p.threadId)
        if (p.page) {
          const history = await orchestrator.historyPage(p.threadId, p.page)
          const running = orchestrator.isTurnRunning(p.threadId)
          const approval = store.threadApproval(p.threadId) ?? 'ask'
          if (p.page.before === undefined) orchestrator.markThreadRead(p.threadId)
          return {
            events: history.events,
            running,
            approval,
            ...(history.reset ? { reset: true } : {}),
            page: history.page,
          }
        }
        const reset =
          p.afterSeq !== undefined &&
          (store.providerHistoryChangedAfter(p.threadId, p.afterSeq) ||
            store.historyRewrittenAfter(p.threadId, p.afterSeq))
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
        // A chat's limits are those of the account it runs as; otherwise the
        // named account's, which the orchestrator refuses if it cannot run.
        const accountId = thread ? thread.accountId : 'accountId' in p ? p.accountId : undefined
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
        return usageSummaryWithLimits(
          totals,
          provider,
          (requestedProvider) =>
            orchestrator.usageLimitSource(requestedProvider, p.intent, accountId),
          (requestedProvider) =>
            orchestrator.heldLimitSource(requestedProvider, p.intent, accountId),
        )
      }

      case 'usage.history': {
        const p = parseParams(method, params)
        // An account the provider cannot have, or one that is gone, is refused.
        if (p.account) accounts.home(p.account.provider, p.account.accountId)
        return (await usageHistoryService()).history(p.range, p.refresh ?? false, p.account)
      }

      case 'usage.resetHistory':
        await (await usageHistoryService()).resetAndRefresh()
        return { started: true as const }

      case 'usage.consumeReset': {
        const p = parseParams(method, params)
        return orchestrator.consumeRateLimitReset(
          p.provider,
          p.idempotencyKey,
          p.creditId,
          p.accountId,
        )
      }

      case 'sideChat.start': {
        const p = parseParams(method, params)
        const thread = await orchestrator.startSideThread(p.parentThreadId, {
          model: p.model,
          serviceTier: p.serviceTier,
          effort: p.effort,
          approval: p.approval,
        })
        startedThisRun.add(thread.id)
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
          accountId: p.accountId,
          continueFrom: p.continueFrom,
          isolate: p.isolate,
        })
        startedThisRun.add(thread.id)
        const earlierChanges = orchestrator.earlierChanges(thread.id)
        return { threadId: thread.id, ...(earlierChanges ? { earlierChanges } : {}) }
      }

      case 'thread.changeProvider': {
        const p = parseParams(method, params)
        await orchestrator.changeProvider(p.threadId, {
          provider: p.provider,
          agent: p.agent,
          accountId: p.accountId,
          model: p.model,
          serviceTier: p.serviceTier,
          effort: p.effort,
          approval: p.approval,
        })
        // The saved copy of the session the chat left stays its own; the new
        // session's copy is linked by the next scan. That scan is scheduled,
        // not run now: it reads every saved session, and the first turn on
        // the new provider is about to start.
        providerHistoryReady?.forget(p.threadId)
        startedThisRun.add(p.threadId)
        historySchedule.activity()
        return {}
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
        const restored = await orchestrator.restoreCheckpoint(p.threadId, p.checkpointId)
        // Other clients still show the removed turns. Have them reload the chat.
        push.broadcast('providerHistory.changed', { threadIds: [p.threadId] })
        return restored
      }

      case 'thread.undoRestore': {
        const p = parseParams(method, params)
        await orchestrator.undoRestore(p.threadId, p.undo)
        push.broadcast('providerHistory.changed', { threadIds: [p.threadId] })
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

      default:
        // The contract can declare a method before this server routes it (a
        // newer client, or a contract that landed ahead of its handler). Say
        // so instead of replying with an empty result the client would trust.
        throw new UnknownMethodError(method)
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
      clearTimeout(backgroundTimer)
      historySchedule.stop()
      cliProbe.waitBeforeReads(undefined)
      // Terminal jobs get a fixed shutdown budget; waiting on provider history
      // first would spend it. disposeAll below waits for the same close.
      void orchestrator.closeAllTerminals().catch(() => undefined)
      await providerHistory?.then((history) => history.close()).catch(() => undefined)
      lifecycleScheduler.dispose()
      usageHistoryClosing = true
      await usageHistory?.then((service) => service.dispose()).catch(() => undefined)
      const orchestratorClosed = orchestrator.disposeAll()
      for (const socket of wss.clients) socket.terminate()
      const results = await Promise.allSettled([
        orchestratorClosed,
        stopModelListings(),
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
 * `file://` (the packaged Electron renderer), and the exact renderer origin.
 * Browsers always send Origin on an upgrade; an empty or opaque one is not
 * equivalent to the missing header of a non-browser client.
 *
 * The dev renderer defaults to http://127.0.0.1:5183. HARNESS_RENDERER_ORIGIN
 * replaces it for a custom renderer port; desktop-owned servers set file://
 * so a packaged app does not trust an unrelated HTTP server on the dev port.
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
export function allowedOrigin(
  origin: string | undefined,
  accessToken?: string,
  rendererOrigin = DEFAULT_RENDERER_ORIGIN,
): boolean {
  if (origin === undefined || origin === 'file://') return true
  if (origin === 'null') return false
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false
  } catch {
    return false
  }
  return Boolean(accessToken) || origin === rendererOrigin
}

function httpOriginPort(origin: string): number[] {
  const url = URL.parse(origin)
  return url?.protocol === 'http:' ? [Number(url.port || 80)] : []
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

/** A declared method that `route` has no case for yet. */
class UnknownMethodError extends Error {
  constructor(method: string) {
    super(`unknown method: ${method}`)
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
  let supplied: string | null
  try {
    supplied = new URL(requestUrl ?? '/', 'ws://harness.local').searchParams.get('token')
  } catch {
    return false
  }
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
