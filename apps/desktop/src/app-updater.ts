import type { AppUpdater, UpdateInfo } from 'electron-updater'
import type { BuildEdition } from './owned-server-env.js'

export type UpdateClient = Pick<
  AppUpdater,
  | 'allowDowngrade'
  | 'allowPrerelease'
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'on'
  | 'quitAndInstall'
> & { dispose?: () => void | Promise<void> }

export type AppUpdateState = {
  status:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'preparing'
    | 'current'
    | 'ready'
    | 'error'
  currentVersion: string
  version?: string
  progress?: number
  error?: string
}

type Timer = ReturnType<typeof setTimeout>

/** Who asked for an update attempt. Only a person's own attempt may show its failure. */
export type UpdateCheckOrigin = 'user' | 'background'

const FIRST_CHECK_DELAY = 15_000
const CHECK_INTERVAL = 60 * 60 * 1000
// A failed background attempt retries sooner than the hourly check, then backs
// off so an offline machine does not keep asking GitHub.
const RETRY_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000]

// GitHub names the moment its rate limit resets; asking sooner is wasted.
function retryAt(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null || !('retryAt' in cause)) return undefined
  return typeof cause.retryAt === 'number' ? cause.retryAt : undefined
}

export function createAppUpdateController(
  options: {
    currentVersion: string
    enabled: boolean
    /**
     * Whether a downloaded update may install by itself when the app quits.
     * A dev build passes false: it still finds, downloads and offers the public
     * release, but installs it only when the user clicks Update, so quitting
     * never swaps its providers for the release's. Defaults to true.
     */
    installOnQuit?: boolean
    /** Receives every failure, including the background ones the UI never shows. */
    onError?: (cause: unknown) => void
    setTimeoutFn?: typeof setTimeout
    clearTimeoutFn?: typeof clearTimeout
  } & (
    | { updater: UpdateClient; loadUpdater?: never }
    | { updater?: never; loadUpdater: () => Promise<UpdateClient> }
  ),
) {
  const listeners = new Set<(state: AppUpdateState) => void>()
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  const lazyLoadUpdater = options.loadUpdater
  let timer: Timer | undefined
  let started = false
  let checking: Promise<AppUpdateState> | undefined
  let loading: Promise<UpdateClient> | undefined
  let updater = options.updater
  let updaterConfigured = false
  let state: AppUpdateState = {
    status: options.enabled ? 'idle' : 'unsupported',
    currentVersion: options.currentVersion,
  }
  // One attempt is a check plus the download it starts. electron-updater reports
  // a failure twice (an `error` event and a rejected promise); count it once.
  let attempt = 0
  let failedAttempt = -1
  let failures = 0
  let quiet = false
  let settled = state
  let lastCheckAt = 0
  const installOnQuit = options.installOnQuit ?? true
  let quitPrepared = false
  // Set when a quit begins while agents run; that quit installs nothing.
  let quitWithAgents = false

  const reschedule = (delay: number) => {
    if (!started) return
    if (timer) clearTimeoutFn(timer)
    timer = setTimeoutFn(() => {
      timer = undefined
      void check('background').finally(() => {
        // A failure has already set its own, shorter retry.
        if (!timer) reschedule(CHECK_INTERVAL)
      })
    }, delay)
    timer.unref?.()
  }

  const publish = (next: AppUpdateState) => {
    state = next
    for (const listener of listeners) listener(state)
  }
  const versioned = (status: AppUpdateState['status'], info: UpdateInfo): AppUpdateState => ({
    status,
    currentVersion: options.currentVersion,
    version: info.version,
  })
  const fail = (cause: unknown) => {
    if (failedAttempt === attempt) return
    failedAttempt = attempt
    failures += 1
    options.onError?.(cause)
    const backoff = RETRY_DELAYS[failures - 1] ?? CHECK_INTERVAL
    const deferred = retryAt(cause)
    reschedule(deferred === undefined ? backoff : Math.max(backoff, deferred - Date.now()))
    // An offline launch or a GitHub outage is not the user's problem until they
    // ask. A failed install of a ready update always is.
    if (quiet && state.status !== 'ready') {
      publish(settled)
      return
    }
    publish({
      status: 'error',
      currentVersion: options.currentVersion,
      error: cause instanceof Error ? cause.message : String(cause),
    })
  }
  const succeed = (next: AppUpdateState) => {
    failures = 0
    publish(next)
  }

  const configureUpdater = (client: UpdateClient): UpdateClient => {
    if (updaterConfigured) return client
    updater = client
    updaterConfigured = true
    client.autoDownload = false
    // Read when the download finishes, and again on Windows when the app quits:
    // electron-updater registers its quit handler only if this is true then, so
    // a dev build that starts with false never gets one.
    client.autoInstallOnAppQuit = installOnQuit && !quitWithAgents
    client.allowPrerelease = true
    client.allowDowngrade = false
    client.on('checking-for-update', () =>
      publish({ status: 'checking', currentVersion: options.currentVersion }),
    )
    client.on('update-not-available', (info) => succeed(versioned('current', info)))
    client.on('update-available', (info) => {
      publish(versioned('downloading', info))
      void client.downloadUpdate().catch(fail)
    })
    client.on('download-progress', (progress) => {
      // After the last byte, verification and the hand-over to the native
      // updater take a while, and electron-updater reports its local copy as a
      // second download from 0 percent. Neither is the user's download.
      if (state.status === 'preparing') return
      publish(
        progress.percent >= 100
          ? {
              status: 'preparing',
              currentVersion: options.currentVersion,
              ...(state.version ? { version: state.version } : {}),
            }
          : {
              ...state,
              status: 'downloading',
              currentVersion: options.currentVersion,
              progress: Math.round(progress.percent),
            },
      )
    })
    client.on('update-downloaded', (info) => succeed(versioned('ready', info)))
    client.on('error', fail)
    return client
  }

  if (updater) configureUpdater(updater)

  const loadUpdater = (): Promise<UpdateClient> => {
    if (updater) return Promise.resolve(updater)
    if (!lazyLoadUpdater) return Promise.reject(new Error('No app updater is available.'))
    loading ??= lazyLoadUpdater()
      .then(configureUpdater)
      .catch((error: unknown) => {
        loading = undefined
        throw error
      })
    return loading
  }

  const check = (origin: UpdateCheckOrigin = 'user'): Promise<AppUpdateState> => {
    if (!options.enabled) return Promise.resolve(state)
    // A person who joins a background attempt is now waiting on its outcome.
    if (origin === 'user') quiet = false
    if (checking) return checking
    if (['downloading', 'preparing', 'ready'].includes(state.status)) return Promise.resolve(state)
    attempt += 1
    quiet = origin === 'background'
    settled = state
    lastCheckAt = Date.now()
    checking = loadUpdater()
      .then((client) => client.checkForUpdates())
      .then(
        () => state,
        (error) => {
          fail(error)
          return state
        },
      )
      .finally(() => {
        checking = undefined
      })
    return checking
  }

  return {
    state: () => state,
    check,
    install: () => {
      if (state.status !== 'ready' || !updater) return false
      updater.quitAndInstall(false, true)
      return true
    },
    /**
     * Called once, when a quit begins, with whether any agent was running.
     * Whatever the agents do while the server shuts down, the answer at that
     * moment decides: such a quit installs nothing, and the ready update waits
     * for a later quit or the Update button.
     *
     * The quit itself ends those agents, so installing would not cut anything
     * off. But the person was in the middle of work and is likely to start
     * TasteCode again right away, and on Windows the update runs as a separate
     * installer after the app has exited, which closes a TasteCode that is
     * running and replaces its files. A quick relaunch would race it, and so
     * would the agents started in it. On macOS this flag no longer matters
     * once the update is ready: Squirrel.Mac already holds it and applies it
     * after the app has exited.
     */
    prepareForQuit: (agentsRunning: boolean) => {
      if (quitPrepared) return
      quitPrepared = true
      if (!agentsRunning) return
      quitWithAgents = true
      if (updater) updater.autoInstallOnAppQuit = false
    },
    subscribe: (listener: (next: AppUpdateState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      if (!options.enabled || started) return
      started = true
      lastCheckAt = Date.now()
      reschedule(FIRST_CHECK_DELAY)
    },
    // Timers stand still while the machine sleeps, so a check that came due
    // overnight would otherwise wait another hour of waking time.
    resume: () => {
      if (started && Date.now() - lastCheckAt >= CHECK_INTERVAL) reschedule(FIRST_CHECK_DELAY)
    },
    dispose: () => {
      started = false
      if (timer) clearTimeoutFn(timer)
      timer = undefined
      listeners.clear()
      return updater?.dispose?.()
    },
  }
}

export type AppUpdateController = ReturnType<typeof createAppUpdateController>

/**
 * Whether a build's downloaded update may install by itself when the app
 * quits. Updates come from the public release, which offers fewer providers
 * than a dev build: a dev build offers them, but installs one only on Update.
 * An unpackaged run has no edition (and no updater).
 */
export function installsUpdateOnQuit(edition: BuildEdition | undefined): boolean {
  return edition !== 'dev'
}

/**
 * How many chats the renderer reports with a running turn (starting, working,
 * or waiting on an approval or a question), across every project, background
 * chat and split pane. Anything else is not a count.
 */
export function parseRunningAgents(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
