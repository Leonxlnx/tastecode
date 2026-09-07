import { posix as posixPath } from 'node:path'
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

export function appOwnsUpdates(options: {
  platform: NodeJS.Platform
  packaged: boolean
  developmentServer?: string | undefined
  appImagePath?: string | undefined
  appDirPath?: string | undefined
  executablePath?: string | undefined
}): boolean {
  if (!options.packaged || options.developmentServer) return false
  if (options.platform === 'linux') {
    // An unpacked binary (or deb) can inherit APPIMAGE from a parent AppImage
    // process (e.g. T3 Code launching linux-unpacked/tastecode). Owning
    // updates then points electron-updater at a foreign release feed. Only the
    // running AppImage itself — executable inside its own APPDIR with an
    // external APPIMAGE — owns them.
    if (!options.appImagePath || !options.appDirPath || !options.executablePath) return false
    return isOwnAppImageMount(options.appImagePath, options.appDirPath, options.executablePath)
  }
  return options.platform === 'win32' || options.platform === 'darwin'
}

// Linux-only containment uses POSIX semantics so POSIX fixtures agree with
// production no matter which OS runs the tests. No realpath: string-level
// containment is enough to decide updater ownership.
function isOwnAppImageMount(
  appImagePath: string,
  appDirPath: string,
  executablePath: string,
): boolean {
  if (
    !posixPath.isAbsolute(appImagePath) ||
    !posixPath.isAbsolute(appDirPath) ||
    !posixPath.isAbsolute(executablePath)
  ) {
    return false
  }
  if (!isStrictlyInsidePosixDir(appDirPath, executablePath)) return false
  // An extracted squashfs-root keeps APPIMAGE inside (or equal to) APPDIR. A
  // real Type-2 mount keeps the image file outside the mount point.
  if (!isOutsidePosixDir(appDirPath, appImagePath)) return false
  return true
}

// Strict containment, not a string prefix: equality is not containment, `..`
// escapes are outside, and sibling prefixes such as `/mount/App-evil` never
// match `/mount/App`.
function isStrictlyInsidePosixDir(dirPath: string, candidatePath: string): boolean {
  const relative = posixPath.relative(dirPath, candidatePath)
  if (relative === '' || relative === '..' || relative.startsWith('../')) return false
  if (posixPath.isAbsolute(relative)) return false
  return true
}

function isOutsidePosixDir(dirPath: string, candidatePath: string): boolean {
  const relative = posixPath.relative(dirPath, candidatePath)
  if (relative === '') return false
  if (relative === '..' || relative.startsWith('../')) return true
  if (posixPath.isAbsolute(relative)) return true
  return false
}

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

  // Outside a packaged build the controller stays inert: touching the updater
  // would attach listeners and flip flags on a client nobody will ever check.
  if (options.enabled && updater) configureUpdater(updater)

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
