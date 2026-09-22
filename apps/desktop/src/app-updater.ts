import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { isNewerVersion, releasePageUrl, type LatestRelease } from './release-check.js'

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
    'unsupported' | 'manual' | 'idle' | 'checking' | 'downloading' | 'current' | 'ready' | 'error'
  currentVersion: string
  version?: string
  progress?: number
  error?: string
  // Manual-mode signal only: a published release newer than the running one,
  // plus the releases page to download it from. Install states never set these.
  latestVersion?: string
  releasesUrl?: string
}

type Timer = ReturnType<typeof setTimeout>

export type AppUpdateMode = 'unsupported' | 'manual' | 'install'

export function appUpdateMode(options: {
  platform: NodeJS.Platform
  packaged: boolean
  developmentServer?: string | undefined
  appImage?: boolean | undefined
}): AppUpdateMode {
  if (!options.packaged || options.developmentServer) return 'unsupported'
  // electron-updater replaces an AppImage in place; a deb install is owned by
  // the system package manager and stays on manual updates.
  if (options.platform === 'linux') return options.appImage ? 'install' : 'manual'
  if (options.platform === 'win32' || options.platform === 'darwin') return 'install'
  return 'unsupported'
}

export function createAppUpdateController(
  options: {
    currentVersion: string
    mode: AppUpdateMode
    // Read-only "is a newer release published" probe for manual packages; the
    // injected function resolves undefined when no app release is published.
    fetchLatest?: () => Promise<LatestRelease | undefined>
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
    status: options.mode === 'install' ? 'idle' : options.mode,
    currentVersion: options.currentVersion,
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
  const publishError = (cause: unknown) => {
    const releasesUrl =
      options.mode === 'manual' ? (state.releasesUrl ?? releasePageUrl) : undefined
    publish({
      status: 'error',
      currentVersion: options.currentVersion,
      error: cause instanceof Error ? cause.message : String(cause),
      ...(releasesUrl ? { releasesUrl } : {}),
    })
  }
  const ignoreLateError = (cause: unknown) => {
    // A stray late error — a post-download signature probe, a racing second
    // check — must not throw away an installable update or a live download.
    if (state.status === 'ready' || state.status === 'downloading') return
    publishError(cause)
  }
  const publishDownloadError = (cause: unknown) => {
    // The ready event is the installable handoff. A later promise rejection
    // cannot invalidate an update that the updater has already prepared.
    if (state.status === 'ready') return
    publishError(cause)
  }

  const configureUpdater = (client: UpdateClient): UpdateClient => {
    if (updaterConfigured) return client
    updater = client
    updaterConfigured = true
    client.autoDownload = false
    client.autoInstallOnAppQuit = true
    client.allowPrerelease = true
    client.allowDowngrade = false
    client.on('checking-for-update', () =>
      publish({ status: 'checking', currentVersion: options.currentVersion }),
    )
    client.on('update-not-available', (info) => publish(versioned('current', info)))
    client.on('update-available', (info) => {
      publish(versioned('downloading', info))
      // electron-updater emits `error` before rejecting this promise. Keep the
      // event from racing a live download, then use the owned promise result as
      // the terminal verdict for this download attempt.
      void client.downloadUpdate().catch(publishDownloadError)
    })
    client.on('download-progress', (progress) => {
      // A state left over from a failed check would otherwise leak its stale
      // error field into the live download.
      const { error: _stale, ...rest } = state
      publish({
        ...rest,
        status: 'downloading',
        currentVersion: options.currentVersion,
        progress: Math.round(progress.percent),
      })
    })
    client.on('update-downloaded', (info) => publish(versioned('ready', info)))
    client.on('error', ignoreLateError)
    return client
  }

  // Outside a packaged build the controller stays inert: touching the updater
  // would attach listeners and flip flags on a client nobody will ever check.
  if (options.mode === 'install' && updater) configureUpdater(updater)

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

  // Manual mode keeps its own status for both outcomes: the renderer learns
  // "newer release exists" from latestVersion rather than a status flip, and a
  // deb swapped by dpkg under a running process drops a stale signal cleanly.
  const checkLatestRelease = (): Promise<AppUpdateState> => {
    const fetchLatest = options.fetchLatest
    if (!fetchLatest) return Promise.resolve(state)
    return fetchLatest()
      .then((latest) => {
        if (!latest) {
          publish({
            status: 'manual',
            currentVersion: options.currentVersion,
            releasesUrl: releasePageUrl,
          })
          return state
        }
        publish(
          isNewerVersion(options.currentVersion, latest.version)
            ? {
                status: 'manual',
                currentVersion: options.currentVersion,
                latestVersion: latest.version,
                releasesUrl: latest.releasesUrl,
              }
            : {
                status: 'manual',
                currentVersion: options.currentVersion,
                releasesUrl: latest.releasesUrl,
              },
        )
        return state
      })
      .catch((error: unknown) => {
        publishError(error)
        return state
      })
  }

  const installCheck = (): Promise<AppUpdateState> =>
    loadUpdater()
      .then((client) => client.checkForUpdates())
      .then(
        () => state,
        (error) => {
          ignoreLateError(error)
          return state
        },
      )

  const check = (): Promise<AppUpdateState> => {
    if (options.mode === 'unsupported') return Promise.resolve(state)
    if (checking) return checking
    if (state.status === 'downloading' || state.status === 'ready') return Promise.resolve(state)
    checking = (options.mode === 'manual' ? checkLatestRelease() : installCheck()).finally(() => {
      checking = undefined
    })
    return checking
  }

  // Install mode polls hourly like before; the manual probe is one cheap GET
  // against a public API, so six hours is plenty of freshness for a banner.
  const checkInterval = options.mode === 'manual' ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000

  const schedule = (delay: number) => {
    timer = setTimeoutFn(() => {
      timer = undefined
      void check().finally(() => {
        if (started) schedule(checkInterval)
      })
    }, delay)
    timer.unref?.()
  }

  return {
    state: () => state,
    check,
    install: () => {
      if (state.status !== 'ready' || !updater) return false
      updater.quitAndInstall(false, true)
      return true
    },
    subscribe: (listener: (next: AppUpdateState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      if (options.mode === 'unsupported' || started) return
      started = true
      schedule(15_000)
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
