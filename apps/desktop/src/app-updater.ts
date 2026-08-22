import type { AppUpdater, UpdateInfo } from 'electron-updater'

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
>

export type AppUpdateState = {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'current' | 'ready' | 'error'
  currentVersion: string
  version?: string
  progress?: number
  error?: string
}

type Timer = ReturnType<typeof setTimeout>

export function createAppUpdateController(
  options: {
    currentVersion: string
    enabled: boolean
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
  let checking: Promise<AppUpdateState> | undefined
  let loading: Promise<UpdateClient> | undefined
  let updater = options.updater
  let updaterConfigured = false
  let state: AppUpdateState = {
    status: options.enabled ? 'idle' : 'unsupported',
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
  const fail = (cause: unknown) =>
    publish({
      status: 'error',
      currentVersion: options.currentVersion,
      error: cause instanceof Error ? cause.message : String(cause),
    })

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
      void client.downloadUpdate().catch(fail)
    })
    client.on('download-progress', (progress) =>
      publish({
        ...state,
        status: 'downloading',
        currentVersion: options.currentVersion,
        progress: Math.round(progress.percent),
      }),
    )
    client.on('update-downloaded', (info) => publish(versioned('ready', info)))
    client.on('error', fail)
    return client
  }

  if (updater) configureUpdater(updater)

  const loadUpdater = (): Promise<UpdateClient> => {
    if (updater) return Promise.resolve(updater)
    if (!lazyLoadUpdater) return Promise.reject(new Error('No app updater is available.'))
    loading ??= lazyLoadUpdater().then(configureUpdater)
    return loading
  }

  const check = (): Promise<AppUpdateState> => {
    if (!options.enabled) return Promise.resolve(state)
    if (checking) return checking
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
    subscribe: (listener: (next: AppUpdateState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      if (!options.enabled || timer) return
      timer = setTimeoutFn(() => {
        timer = undefined
        void check()
      }, 15_000)
      timer.unref?.()
    },
    dispose: () => {
      if (timer) clearTimeoutFn(timer)
      timer = undefined
      listeners.clear()
    },
  }
}

export type AppUpdateController = ReturnType<typeof createAppUpdateController>
