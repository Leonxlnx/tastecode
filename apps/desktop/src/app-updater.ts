import type { AppUpdater, UpdateInfo } from 'electron-updater'

type UpdateClient = Pick<
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

export function appOwnsUpdates(options: {
  platform: NodeJS.Platform
  packaged: boolean
  developmentServer?: string
  appImagePath?: string
}): boolean {
  if (!options.packaged || options.developmentServer) return false
  if (options.platform === 'linux') return Boolean(options.appImagePath)
  return options.platform === 'win32' || options.platform === 'darwin'
}

export function createAppUpdateController(options: {
  updater: UpdateClient
  currentVersion: string
  enabled: boolean
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}) {
  const listeners = new Set<(state: AppUpdateState) => void>()
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  let timer: Timer | undefined
  let checking: Promise<AppUpdateState> | undefined
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

  if (options.enabled) {
    options.updater.autoDownload = false
    options.updater.autoInstallOnAppQuit = true
    options.updater.allowPrerelease = true
    options.updater.allowDowngrade = false
    options.updater.on('checking-for-update', () =>
      publish({ status: 'checking', currentVersion: options.currentVersion }),
    )
    options.updater.on('update-not-available', (info) => publish(versioned('current', info)))
    options.updater.on('update-available', (info) => {
      publish(versioned('downloading', info))
      void options.updater.downloadUpdate().catch(fail)
    })
    options.updater.on('download-progress', (progress) =>
      publish({
        ...state,
        status: 'downloading',
        currentVersion: options.currentVersion,
        progress: Math.round(progress.percent),
      }),
    )
    options.updater.on('update-downloaded', (info) => publish(versioned('ready', info)))
    options.updater.on('error', fail)
  }

  const check = (): Promise<AppUpdateState> => {
    if (!options.enabled) return Promise.resolve(state)
    if (checking) return checking
    checking = options.updater
      .checkForUpdates()
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
      if (state.status !== 'ready') return false
      options.updater.quitAndInstall(false, true)
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
