import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  type Event as ElectronEvent,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type WebContents,
} from 'electron'
import type { PreviewCaptureRequest } from '@harness/contracts'
import { applyDesktopPath, desktopPath } from '@harness/proc/desktop-path'
import {
  ATTACHMENT_PREVIEW_SCHEME,
  attachmentByteRange,
  attachmentPreviewFromUrl,
  pickedAttachment,
} from './attachment-preview.js'
import { shouldHideWindowOnClose } from './background-lifecycle.js'
import {
  appUpdateMode,
  createAppUpdateController,
  type AppUpdateController,
  type AppUpdateState,
} from './app-updater.js'
import { createApplicationMenuTemplate } from './app-menu.js'
import { clipboardText } from './clipboard-text.js'
import { droppedFolderPaths, MAX_DROPPED_PROJECT_PATHS } from './dropped-folder-paths.js'
import { browserGuestUrl, configureEmbeddedBrowser } from './embedded-browser.js'
import { configureImageContextMenu } from './image-context-menu.js'
import { isMacHapticPattern, MacOSHaptics } from './macos-haptics.js'
import { localDiagnosticsDirectory, LocalDiagnostics } from './local-diagnostics.js'
import { allowsMicrophoneRequest, isOwnRendererPermission } from './media-permissions.js'
import {
  parseNativeMenuShortcuts,
  type NativeMenuAction,
  type NativeMenuShortcuts,
} from './menu-contract.js'
import { allowsPreviewNavigation } from './preview-navigation.js'
import { pastedFile } from './pasted-file.js'
import { revealablePath } from './reveal-path.js'
import { projectFilePath } from './project-file-path.js'
import { PreviewCaptureOwner } from './preview-capture.js'
import { ServerSupervisor, type SupervisedServerProcess } from './server-supervisor.js'
import { startupSettleDelay, summarizeAppMetrics } from './startup-metrics.js'
import { restoreMainWindowPresence } from './window-presence.js'
import { startVisibilityWatchdog } from './window-visibility-watchdog.js'
import {
  loadMainWindowState,
  persistMainWindowState,
  restoreMainWindowState,
  saveMainWindowState,
  type MainWindowStatePersistence,
} from './window-state.js'
import { windowThemeOptions, windowThemeSource } from './window-theme.js'
import {
  DEFAULT_ZOOM_FACTOR,
  isZoomAction,
  nextZoomFactor,
  type ZoomAction,
  zoomShortcut,
} from './zoom-shortcuts.js'
import { viewedImagePath } from './viewed-image-path.js'

applyDesktopPath()

/**
 * Electron shell. Deliberately thin: it opens a window and nothing else.
 *
 * All privileged work — spawning agents, filesystem, credentials — lives in the
 * core server. The renderer talks to that over WebSocket, which keeps the
 * browser and desktop surfaces on the same protocol. See docs/ARCHITECTURE.md.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const productIconPath = path.join(here, '../assets/tastecode-app-icon.png')
const nativeAppName = 'Taste Code'
// Performance runs must never read or rewrite the user's real window and
// Chromium state. Keep the override opt-in so normal installs stay on the
// long-standing TasteCode path.
const productDataPath = process.env['HARNESS_DESKTOP_DATA_DIR']
  ? path.resolve(process.env['HARNESS_DESKTOP_DATA_DIR'])
  : path.join(app.getPath('appData'), 'TasteCode')
const mainWindowStatePath = path.join(productDataPath, 'window-state.json')
const defaultMainWindowSize = { width: 1180, height: 820 }
const minimumMainWindowSize = { width: 720, height: 520 }
const startupStartedAt = Number(process.env['HARNESS_STARTUP_STARTED_AT'])
const startupSettledMetricsDelayMs = startupSettleDelay(process.env['HARNESS_STARTUP_SETTLE_MS'])
const startupRendererPath =
  Number.isFinite(startupStartedAt) &&
  startupStartedAt > 0 &&
  process.env['HARNESS_STARTUP_RENDERER']
    ? path.resolve(process.env['HARNESS_STARTUP_RENDERER'])
    : undefined

function logStartupMilestone(name: string): void {
  if (!Number.isFinite(startupStartedAt) || startupStartedAt <= 0) return
  console.log(`[startup] ${name} ${Date.now() - startupStartedAt}ms`)
}

logStartupMilestone('main-module')

// Keep the existing storage location while the OS-facing product name gains a space.
app.setPath('userData', productDataPath)
app.setPath('sessionData', productDataPath)

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}
const devServer = process.env['HARNESS_DEV_SERVER']
let startupWindowReady = false
let startupServerReady = Boolean(devServer)
let startupRendererReady = false
let startupHydratedReady = false
let startupCatalogReady = false
let startupExitScheduled = false

function finishStartupBenchmarkIfReady(): void {
  if (
    process.env['HARNESS_STARTUP_EXIT_AFTER_READY'] !== '1' ||
    !startupWindowReady ||
    !startupServerReady ||
    !startupRendererReady ||
    !startupHydratedReady ||
    !startupCatalogReady ||
    startupExitScheduled
  ) {
    return
  }
  startupExitScheduled = true
  if (startupSettledMetricsDelayMs === undefined) {
    setImmediate(() => app.quit())
    return
  }

  // The first read establishes the CPU and wakeup interval. Electron reports
  // both values since the previous read; memory is sampled at the end.
  app.getAppMetrics()
  setTimeout(() => {
    const metrics = app.getAppMetrics()
    void import('./performance-memory.js')
      .then(async ({ collectSettledBenchmarkMemory }) => {
        const memory = await collectSettledBenchmarkMemory(() => app.getAppMetrics())
        console.log(
          '[startup] settled ' + JSON.stringify({ ...summarizeAppMetrics(metrics), memory }),
        )
        app.quit()
      })
      .catch((error: unknown) => {
        console.error('[startup] memory measurement failed', error)
        app.exit(1)
      })
  }, startupSettledMetricsDelayMs)
}

const attachmentPreviewSecret = randomBytes(32)
const attachmentThumbnailCache = new Map<string, Promise<Buffer | undefined>>()
const MAX_ATTACHMENT_THUMBNAILS = 64
/** Hidden capture windows are real BrowserWindows; lifecycle checks that count
 *  "the app's windows" must not count them. */
const captureWindows = new Set<BrowserWindow>()
const previewCaptures = new PreviewCaptureOwner({
  createWindow: createPreviewWindow,
  releaseWindow: (window) => {
    captureWindows.delete(window)
  },
  directory: (requestId) =>
    path.join(app.getPath('temp'), 'TasteCode', 'preview-captures', requestId),
  parseAudit: async (value) => {
    const { PreviewDomAuditSchema } = await import('@harness/contracts')
    return PreviewDomAuditSchema.parse(value)
  },
})
// Windows' native occlusion tracker can wrongly decide the window is fully
// covered and stick there: the page keeps running with visibilityState
// 'hidden' while the window shows nothing but its background colour — the
// intermittent all-black window. Verified over CDP: DOM complete, renderer
// healthy, compositor off. The watchdog below covers whatever this misses.
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.tastecode.desktop')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}
app.setName(nativeAppName)
// Diagnostics for the field: software rendering and a DevTools port, both
// opt-in via environment so a broken machine can be inspected.
if (process.env['HARNESS_DISABLE_GPU'] === '1') app.disableHardwareAcceleration()
if (process.env['HARNESS_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['HARNESS_DEBUG_PORT'])
}
// A machine whose GPU process cannot launch (some Wayland/Vulkan stacks) must
// fall back to software rendering, not FATAL on "GPU process isn't usable".
if (process.env['HARNESS_DISABLE_GPU'] !== '1') {
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit')
}

const ownsSingleInstance = app.requestSingleInstanceLock()
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let appIsQuitting = false
let serverSupervisor: ServerSupervisor | undefined
let diagnostics: LocalDiagnostics | undefined
let appUpdater: AppUpdateController | undefined
let mainWindowStatePersistence: MainWindowStatePersistence | undefined

if (Number.isFinite(startupStartedAt) && startupStartedAt > 0) {
  ipcMain.on('harness:startupPreloadReady', (_event, elapsed: unknown) => {
    if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) {
      console.log(`[startup] preload-ready ${Math.round(elapsed)}ms`)
    }
  })
  ipcMain.on('harness:startupRendererMilestone', (_event, name: unknown) => {
    if (
      name !== 'module-loaded' &&
      name !== 'react-commit' &&
      name !== 'first-frame' &&
      name !== 'projects-requested' &&
      name !== 'projects-frame-parsed' &&
      name !== 'projects-validated' &&
      name !== 'projects-received' &&
      name !== 'projects-reconciled' &&
      name !== 'projects-ready' &&
      name !== 'catalog-ready'
    ) {
      return
    }
    logStartupMilestone(name)
    if (name === 'first-frame') {
      startupRendererReady = true
      finishStartupBenchmarkIfReady()
    }
    if (name === 'projects-ready') {
      startupHydratedReady = true
      finishStartupBenchmarkIfReady()
    }
    if (name === 'catalog-ready') {
      startupCatalogReady = true
      finishStartupBenchmarkIfReady()
    }
  })
}
let nativeMenuShortcuts: NativeMenuShortcuts = {}
const macOSHaptics = new MacOSHaptics()

protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, stream: true },
  },
])

if (!ownsSingleInstance) {
  console.error(`[desktop] another ${nativeAppName} instance owns the single-instance lock`)
  app.quit()
}

/**
 * Outside development the shell owns its core server: without this a packaged
 * app has nothing listening on the socket and every feature sits behind a
 * permanent "Reconnecting…". In dev, dev.js runs the server with a watcher and
 * signals that through HARNESS_DEV_SERVER.
 *
 * Packaged builds use Electron's Node utility process so the service stays
 * isolated without paying for a second full app executable launch. The legacy
 * Node-mode child remains available as a field fallback.
 */
function startOwnedServer(): void {
  if (devServer || serverSupervisor) return
  const serverEntry = app.isPackaged
    ? require.resolve('@harness/server')
    : path.join(here, '../../server/dist/main.js')
  const supervisorCallbacks = {
    onLog: (line: string) => {
      console.log('[server]', line)
      if (!startupServerReady && line.startsWith('[server] listening on ')) {
        startupServerReady = true
        logStartupMilestone('server-ready')
        finishStartupBenchmarkIfReady()
      }
    },
    onGaveUp: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: nativeAppName,
          message: 'The core server keeps crashing.',
          detail: 'Restart the app. If this keeps happening, reinstall it.',
        })
      }
    },
  }
  serverSupervisor =
    process.env['HARNESS_LEGACY_SERVER_PROCESS'] === '1'
      ? new ServerSupervisor({
          command: process.execPath,
          args: [serverEntry],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: desktopPath() },
          ...supervisorCallbacks,
        })
      : new ServerSupervisor({
          launch: () => launchUtilityServer(serverEntry),
          ...supervisorCallbacks,
        })
  serverSupervisor.start()
  logStartupMilestone('server-spawned')
}

function launchUtilityServer(serverEntry: string): SupervisedServerProcess {
  const child = utilityProcess.fork(serverEntry, [], {
    env: { ...process.env },
    serviceName: 'Taste Code Core Server',
    stdio: 'pipe',
  })
  return {
    get stdout() {
      return child.stdout
    },
    get stderr() {
      return child.stderr
    },
    kill: () => child.kill(),
    onError: (listener) => {
      child.on('error', (type, location) => listener(new Error(`${type} at ${location}`)))
    },
    onExit: (listener) => {
      child.on('exit', (code) => listener(code, null))
    },
  }
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  const initialTheme = windowThemeOptions('dark')
  const savedWindowState = loadMainWindowState(mainWindowStatePath)
  const restoredWindowState = restoreMainWindowState(
    savedWindowState,
    savedWindowState ? screen.getDisplayMatching(savedWindowState.bounds).workArea : undefined,
    defaultMainWindowSize,
    minimumMainWindowSize,
  )
  const window = new BrowserWindow({
    icon: productIconPath,
    title: nativeAppName,
    ...restoredWindowState.bounds,
    ...(restoredWindowState.fullScreen ? { fullscreen: true } : {}),
    minWidth: minimumMainWindowSize.width,
    minHeight: minimumMainWindowSize.height,
    focusable: true,
    movable: true,
    skipTaskbar: false,
    backgroundColor: initialTheme.backgroundColor,
    // Real glass, the way Codex does it: the OS draws its blur material
    // behind the window, and the renderer keeps every surface opaque except
    // the sidebar column, which is where the material shows through. CSS
    // backdrop-filter cannot do this — inside the page there is nothing
    // behind the sidebar to blur.
    ...(process.platform === 'win32'
      ? {
          backgroundMaterial: 'acrylic' as const,
        }
      : {}),
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar' as const } : {}),
    // Draw our own top bar, but keep native window controls on Windows.
    titleBarStyle: 'hidden',
    // Height and colour must match --titlebar-h and --titlebar-bg in the renderer's
    // tokens. Windows sizes the caption buttons from this number, so if the two
    // drift the buttons stand taller than the bar they sit in — which is
    // invisible until someone screenshots it.
    titleBarOverlay: initialTheme.titleBarOverlay,
    show: false,
    webPreferences: {
      // Hardened from the first commit, not "later". The renderer gets no
      // general native access; its small preload bridge exposes only native
      // UI and tightly validated clipboard operations.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      // Defaults to on, which loads Chromium's spellcheck service and
      // downloads Hunspell dictionaries at first run — the only network
      // traffic the app would ever do outside the renderer's own CSP.
      spellcheck: false,
      // Zoom at creation, not on did-finish-load: a post-load setZoomFactor
      // re-rasterizes while the first frame is pending, and on Wayland the
      // invalidated frame is never reproduced for an unmapped window — the
      // app would sit invisible forever, ready-to-show never firing.
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      preload: path.join(here, 'preload.cjs'),
    },
  })
  mainWindow = window
  configureEmbeddedBrowser(window.webContents)
  configureImageContextMenu(window.webContents, window)
  window.webContents.on('did-attach-webview', (_event, guest) => {
    configureImageContextMenu(guest, window)
  })
  restoreMainWindowPresence(process.platform, app, window)
  const windowStatePersistence = persistMainWindowState(
    window,
    restoredWindowState,
    (state) => saveMainWindowState(mainWindowStatePath, state),
    (error) => console.warn('[desktop] failed to save main window state', error),
  )
  mainWindowStatePersistence = windowStatePersistence
  const stopWatchdog = startVisibilityWatchdog(window, (line) => console.warn('[desktop]', line))
  window.on('closed', stopWatchdog)
  window.on('closed', () => {
    windowStatePersistence.stop()
    if (mainWindowStatePersistence === windowStatePersistence) {
      mainWindowStatePersistence = undefined
    }
  })

  if (restoredWindowState.maximized && !restoredWindowState.fullScreen) window.maximize()

  window.on('close', (event) => {
    if (!shouldHideWindowOnClose(process.platform, appIsQuitting)) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.on('focus', () => restoreMainWindowPresence(process.platform, app, window))
  window.on('show', () => restoreMainWindowPresence(process.platform, app, window))
  window.on('unresponsive', () => {
    console.error('[desktop] main window renderer became unresponsive')
    void diagnostics?.record('renderer', 'Main window became unresponsive')
  })
  window.on('responsive', () => {
    console.info('[desktop] main window renderer recovered')
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[desktop] main window renderer exited: ${details.reason} (code ${details.exitCode})`,
    )
    void diagnostics?.record('renderer crash', `${details.reason} (code ${details.exitCode})`)
  })

  // Avoid the white flash before React paints.
  window.once('ready-to-show', () => {
    logStartupMilestone('ready-to-show')
    startupWindowReady = true
    if (process.env['HARNESS_STARTUP_EXIT_AFTER_READY'] === '1') {
      if (startupSettledMetricsDelayMs !== undefined) window.showInactive()
      finishStartupBenchmarkIfReady()
      return
    }
    showMainWindow()
  })

  // Nothing in this app should ever open a second window, and any external
  // link belongs in the user's browser, not in a chromeless Electron window.
  // Web links only: renderer content includes agent- and vendor-authored
  // URLs, and handing a file:/smb:/ms-*: URL to the OS is code execution.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // Origin comparison, not a prefix check — "http://localhost:5173.evil.example"
    // starts with the dev server string but is not it.
    const allowed = devServer !== undefined && sameOrigin(url, devServer)
    if (!allowed) {
      event.preventDefault()
      if (isWebUrl(url)) void shell.openExternal(url)
    }
  })

  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const action = zoomShortcut(input)
    if (!action) return
    event.preventDefault()
    applyZoom(window, action)
  })

  // If the user closes the last real window while a hidden capture is in
  // flight, the app must still quit/reset — transient windows don't get a vote.
  window.on('closed', () => {
    if (appWindows().length === 0) {
      previewCaptures.cancelAll()
    }
  })

  if (devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadFile(
      startupRendererPath ??
        (app.isPackaged
          ? path.join(process.resourcesPath, 'web', 'index.html')
          : path.join(here, '../../web/dist/index.html')),
    )
  }
}

function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => !captureWindows.has(window))
}

function showMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    createWindow()
    return
  }
  restoreMainWindowPresence(process.platform, app, window)
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createBackgroundTray(): void {
  if (process.platform === 'darwin' || tray) return
  const icon = nativeImage.createFromPath(productIconPath).resize({ width: 20, height: 20 })
  tray = new Tray(icon)
  tray.setToolTip(nativeAppName)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${nativeAppName}`, click: showMainWindow },
      { type: 'separator' },
      { label: `Quit ${nativeAppName}`, click: () => app.quit() },
    ]),
  )
  tray.on('click', showMainWindow)
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      createApplicationMenuTemplate({
        appName: nativeAppName,
        isMacOS: process.platform === 'darwin',
        isDevelopment: !app.isPackaged,
        shortcuts: nativeMenuShortcuts,
        onAction: sendNativeMenuAction,
        onZoom: (action) => {
          const window = mainWindow
          if (window && !window.isDestroyed()) applyZoom(window, action)
        },
        onOpenDiagnostics: () => void openDiagnosticsDirectory(),
      }),
    ),
  )
}

function sendNativeMenuAction(action: NativeMenuAction): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () =>
      mainWindow?.webContents.send('harness:menuAction', action),
    )
    return
  }
  showMainWindow()
  window.webContents.send('harness:menuAction', action)
}

ipcMain.handle('harness:setZoom', (event, action: unknown) => {
  requireOwnRenderer(event.sender)
  if (!isZoomAction(action)) throw new Error('Invalid zoom action')
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No window for zoom action')
  applyZoom(window, action)
})

ipcMain.handle('harness:getDiagnosticsEnabled', (event) => {
  requireOwnRenderer(event.sender)
  return diagnostics?.isEnabled() ?? false
})

ipcMain.handle('harness:setDiagnosticsEnabled', (event, enabled: unknown) => {
  requireOwnRenderer(event.sender)
  if (typeof enabled !== 'boolean') throw new Error('Invalid diagnostics preference')
  return diagnostics?.setEnabled(enabled) ?? false
})

ipcMain.handle('harness:openDiagnostics', async (event) => {
  requireOwnRenderer(event.sender)
  return openDiagnosticsDirectory()
})

ipcMain.on('harness:setMenuShortcuts', (event, value: unknown) => {
  if (!isOwnRenderer(event.sender)) return
  const shortcuts = parseNativeMenuShortcuts(value)
  if (!shortcuts) return
  nativeMenuShortcuts = shortcuts
  installApplicationMenu()
})

ipcMain.on('harness:reportRendererError', (event, value: unknown) => {
  if (!isOwnRenderer(event.sender) || typeof value !== 'string') return
  void diagnostics?.record('renderer', value)
})

ipcMain.handle('harness:getUpdateState', (event): AppUpdateState => {
  requireOwnRenderer(event.sender)
  return (
    appUpdater?.state() ?? {
      status: 'unsupported',
      currentVersion: app.getVersion(),
    }
  )
})

ipcMain.handle('harness:checkForUpdates', (event) => {
  requireOwnRenderer(event.sender)
  return appUpdater?.check()
})

ipcMain.handle('harness:installUpdate', (event) => {
  requireOwnRenderer(event.sender)
  return appUpdater?.install() ?? false
})

ipcMain.handle('harness:setTheme', (event, preference: unknown) => {
  requireOwnRenderer(event.sender)
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No window for theme change')
  nativeTheme.themeSource = windowThemeSource(preference)
  const theme =
    preference === 'codex' ? 'codex' : nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const options = windowThemeOptions(theme)
  // Repainting an opaque background would sit on top of the acrylic/vibrancy
  // material and kill the sidebar glass; on those platforms the material owns
  // the window background and only the caption colours follow the theme.
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    window.setBackgroundColor(options.backgroundColor)
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    window.setTitleBarOverlay(options.titleBarOverlay)
  }
})

ipcMain.on('harness:hapticsPrepare', (event) => {
  if (!isOwnRenderer(event.sender)) return
  macOSHaptics.prepare()
})

ipcMain.on('harness:hapticFeedback', (event, pattern: unknown) => {
  if (!isOwnRenderer(event.sender) || !isMacHapticPattern(pattern)) return
  macOSHaptics.perform(pattern)
})

ipcMain.handle('harness:writeClipboardText', (event, value: unknown) => {
  requireOwnRenderer(event.sender)
  clipboard.writeText(clipboardText(value))
})

ipcMain.handle('harness:capturePreview', (event, value: unknown) =>
  previewCaptures.captureAfterValidation(
    value,
    async () => {
      const { PreviewCaptureRequestSchema } = await import('@harness/contracts')
      return (input) => {
        const parsed = PreviewCaptureRequestSchema.safeParse(input)
        if (!parsed.success) throw new Error('Invalid preview capture request')
        return parsed.data
      }
    },
    () => !appIsQuitting && !event.sender.isDestroyed() && isOwnRenderer(event.sender),
  ),
)

ipcMain.handle('harness:cancelPreviewCapture', (event, value: unknown) => {
  requireOwnRenderer(event.sender)
  if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid preview capture id')
  previewCaptures.cancel(value)
})

ipcMain.handle('harness:openExternal', async (event, url: unknown) => {
  requireOwnRenderer(event.sender)
  await shell.openExternal(browserGuestUrl(url))
})

function applyZoom(window: BrowserWindow, action: ZoomAction): void {
  const factor = nextZoomFactor(window.webContents.getZoomFactor(), action)
  window.webContents.setZoomFactor(factor)
  window.webContents.send('harness:zoomChanged', factor)
}

async function openDiagnosticsDirectory(): Promise<boolean> {
  if (!diagnostics) return false
  await mkdir(diagnostics.directory, { recursive: true, mode: 0o700 })
  return (await shell.openPath(diagnostics.directory)) === ''
}

function createPreviewWindow(request: PreviewCaptureRequest): BrowserWindow {
  const preview = new BrowserWindow({
    width: request.viewports[0]!.width,
    height: request.viewports[0]!.height,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      // The capture owner serializes access and refuses reuse after failed cleanup.
      // Per-request partitions would retain an unbounded number of sessions.
      partition: 'preview-capture',
    },
  })
  captureWindows.add(preview)
  const previewSession = preview.webContents.session

  previewSession.setPermissionCheckHandler(() => false)
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const restrictNavigation = (event: ElectronEvent, url: string) => {
    if (!allowsPreviewNavigation(request.url, url)) event.preventDefault()
  }
  preview.webContents.on('will-navigate', restrictNavigation)
  preview.webContents.on('will-redirect', restrictNavigation)

  return preview
}

/** Screenshot directories older than a day have no consumer left — the design
 *  flow reads them within seconds of the capture. */
async function sweepStaleCaptures(): Promise<void> {
  const root = path.join(app.getPath('temp'), 'TasteCode', 'preview-captures')
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  try {
    for (const entry of await readdir(root)) {
      const target = path.join(root, entry)
      const info = await stat(target)
      if (info.mtimeMs < dayAgo) await rm(target, { recursive: true, force: true })
    }
  } catch {
    // Missing directory or a file in use — nothing worth failing startup over.
  }
}

/**
 * Native path intake. The renderer can ask for a path but never reads the disk
 * itself — the user's own picker or operating-system drop is the only way a
 * path enters the app.
 */
async function showOpenDialogForSender(
  sender: WebContents,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const owner = BrowserWindow.fromWebContents(sender)
  return owner && !owner.isDestroyed()
    ? dialog.showOpenDialog(owner, options)
    : dialog.showOpenDialog(options)
}

ipcMain.handle('harness:pickFolder', async (event) => {
  requireOwnRenderer(event.sender)
  const result = await showOpenDialogForSender(event.sender, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a project folder',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

let droppedFolderPathsSchema: Promise<{ parse(value: unknown): string[] }> | undefined

function parseDroppedFolderPaths(value: unknown): Promise<string[]> {
  droppedFolderPathsSchema ??= import('zod').then(({ z }) =>
    z.array(z.string().min(1).max(32_768)).max(MAX_DROPPED_PROJECT_PATHS),
  )
  return droppedFolderPathsSchema.then((schema) => schema.parse(value))
}

ipcMain.handle('harness:droppedFolderPaths', async (event, value: unknown) => {
  requireOwnRenderer(event.sender)
  return droppedFolderPaths(await parseDroppedFolderPaths(value))
})

ipcMain.handle('harness:pickSkillFolder', async (event) => {
  requireOwnRenderer(event.sender)
  const result = await showOpenDialogForSender(event.sender, {
    properties: ['openDirectory'],
    title: 'Choose an Agent Skill folder',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

ipcMain.handle('harness:pickFiles', async (event) => {
  requireOwnRenderer(event.sender)
  const result = await showOpenDialogForSender(event.sender, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
  })
  return result.canceled
    ? []
    : result.filePaths.map((filePath) => pickedAttachment(filePath, attachmentPreviewSecret))
})

ipcMain.handle('harness:previewViewedImage', async (event, reference: unknown) => {
  requireOwnRenderer(event.sender)
  const filePath = await viewedImagePath(
    reference,
    path.join(app.getPath('temp'), 'TasteCode', 'pasted-files'),
  )
  if (!filePath) return undefined
  const attachment = pickedAttachment(filePath, attachmentPreviewSecret)
  return attachment.mediaType ? attachment : undefined
})

ipcMain.handle('harness:revealPath', (event, value: unknown) => {
  requireOwnRenderer(event.sender)
  shell.showItemInFolder(revealablePath(value))
})

ipcMain.handle('harness:revealProjectFile', (event, value: unknown, projectRootValue: unknown) => {
  requireOwnRenderer(event.sender)
  shell.showItemInFolder(projectFilePath(value, projectRootValue))
})

ipcMain.handle('harness:savePastedFile', async (event, payload: unknown) => {
  requireOwnRenderer(event.sender)
  const file = pastedFile(payload)
  const directory = path.join(app.getPath('temp'), 'TasteCode', 'pasted-files')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = path.join(directory, `${randomUUID()}-${file.name}`)
  await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 })
  return pickedAttachment(destination, attachmentPreviewSecret)
})

if (ownsSingleInstance) {
  app.on('second-instance', showMainWindow)
  app.on('before-quit', () => {
    appIsQuitting = true
    previewCaptures.cancelAll()
    mainWindowStatePersistence?.saveAndStop()
  })
  app.on('will-quit', () => {
    appUpdater?.dispose()
    appUpdater = undefined
    macOSHaptics.stop()
    serverSupervisor?.stop()
    serverSupervisor = undefined
    tray?.destroy()
    tray = undefined
  })

  void app.whenReady().then(async () => {
    logStartupMilestone('app-ready')
    diagnostics = new LocalDiagnostics(localDiagnosticsDirectory(app.getPath('userData')))
    process.on('uncaughtExceptionMonitor', (error) => void diagnostics?.record('main crash', error))
    process.on('unhandledRejection', (error) => void diagnostics?.record('main rejection', error))
    await diagnostics.initialize()
    logStartupMilestone('diagnostics-ready')

    appUpdater = createAppUpdateController({
      loadUpdater: async () => (await import('electron-updater')).default.autoUpdater,
      currentVersion: app.getVersion(),
      mode: appUpdateMode({
        platform: process.platform,
        packaged: app.isPackaged,
        developmentServer: devServer,
      }),
    })
    appUpdater.subscribe((state) => {
      const window = mainWindow
      if (window && !window.isDestroyed()) window.webContents.send('harness:updateState', state)
    })
    appUpdater.start()
    startOwnedServer()
    configureAttachmentPreviews()
    configureRendererPermissions()
    void sweepStaleCaptures()
    createWindow()
    logStartupMilestone('window-created')
    installApplicationMenu()
    if (process.platform === 'win32') createBackgroundTray()
    app.on('activate', showMainWindow)
    if (process.platform === 'darwin') {
      app.on('did-become-active', () => {
        const window = mainWindow
        if (window && !window.isDestroyed()) {
          restoreMainWindowPresence(process.platform, app, window)
        }
      })
    }
  })
}

/** Stream only files that came from the native picker. The signed URL keeps a
 * compromised renderer from turning the preview surface into a filesystem API. */
function configureAttachmentPreviews(): void {
  protocol.handle(ATTACHMENT_PREVIEW_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }

    const preview = attachmentPreviewFromUrl(request.url, attachmentPreviewSecret)
    if (!preview) return new Response(null, { status: 404 })

    try {
      const info = await stat(preview.path)
      if (!info.isFile()) return new Response(null, { status: 404 })

      if (preview.variant === 'thumbnail') {
        const thumbnail = await attachmentThumbnail(
          preview.path,
          `${info.size}:${info.mtimeMs}`,
          preview.mediaType,
        )
        if (!thumbnail) return new Response(null, { status: 404 })
        const headers = {
          'Cache-Control': 'no-store',
          'Content-Length': String(thumbnail.byteLength),
          'Content-Type': 'image/png',
          'X-Content-Type-Options': 'nosniff',
        }
        return new Response(request.method === 'HEAD' ? null : Uint8Array.from(thumbnail), {
          status: 200,
          headers,
        })
      }

      const range = attachmentByteRange(request.headers.get('range'), info.size)
      if (range === 'invalid') {
        return new Response(null, {
          status: 416,
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}` },
        })
      }

      const start = range?.start ?? 0
      const end = range?.end ?? Math.max(0, info.size - 1)
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': String(info.size === 0 ? 0 : end - start + 1),
        'Content-Type': preview.mimeType,
        'X-Content-Type-Options': 'nosniff',
      })
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
      const status = range ? 206 : 200
      if (request.method === 'HEAD' || info.size === 0) {
        return new Response(null, { status, headers })
      }

      const stream = createReadStream(preview.path, { start, end })
      request.signal.addEventListener('abort', () => stream.destroy(), { once: true })
      return new Response(Readable.toWeb(stream), { status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

function attachmentThumbnail(
  filePath: string,
  fingerprint: string,
  mediaType: 'image' | 'video',
): Promise<Buffer | undefined> {
  const cacheKey = `${filePath}\0${fingerprint}`
  const cached = attachmentThumbnailCache.get(cacheKey)
  if (cached) return cached

  const pending = createAttachmentThumbnail(filePath, mediaType)
  attachmentThumbnailCache.set(cacheKey, pending)
  if (attachmentThumbnailCache.size > MAX_ATTACHMENT_THUMBNAILS) {
    const oldest = attachmentThumbnailCache.keys().next().value
    if (oldest) attachmentThumbnailCache.delete(oldest)
  }
  void pending.then((thumbnail) => {
    if (!thumbnail && attachmentThumbnailCache.get(cacheKey) === pending) {
      attachmentThumbnailCache.delete(cacheKey)
    }
  })
  return pending
}

async function createAttachmentThumbnail(
  filePath: string,
  mediaType: 'image' | 'video',
): Promise<Buffer | undefined> {
  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
      width: 256,
      height: 256,
    })
    if (!thumbnail.isEmpty()) {
      const bytes = thumbnail.toPNG()
      if (bytes.byteLength > 0) return bytes
    }
  } catch {
    // Linux has no native thumbnail provider. Raster images still have a safe
    // decoder fallback; videos use the renderer's lightweight media tile.
  }

  if (mediaType !== 'image') return undefined
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return undefined
  const size = image.getSize()
  const scale = Math.min(1, 256 / Math.max(size.width, size.height))
  const thumbnail = image.resize({ width: Math.max(1, Math.round(size.width * scale)) })
  const bytes = thumbnail.toPNG()
  return bytes.byteLength > 0 ? bytes : undefined
}

/** Allow this app's own renderer to request audio and enumerate installed fonts. */
function configureRendererPermissions(): void {
  // Chromium's synchronous check path (navigator.permissions.query, device
  // enumeration) never consults the request handler below and defaults to
  // permissive, so it needs its own answer.
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) =>
      isOwnRendererPermission(permission) && webContents !== null && isOwnRenderer(webContents),
  )
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission !== 'media') {
        callback(isOwnRendererPermission(permission) && isOwnRenderer(webContents))
        return
      }
      if (!isOwnRenderer(webContents) || !allowsMicrophoneRequest(details)) {
        callback(false)
        return
      }

      if (process.platform !== 'darwin') {
        callback(true)
        return
      }

      const status = systemPreferences.getMediaAccessStatus('microphone')
      if (status === 'granted') {
        callback(true)
      } else if (status === 'not-determined') {
        void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false))
      } else {
        callback(false)
      }
    },
  )
}

/** Privileged IPC is for our renderer only — applied to every handler. */
function requireOwnRenderer(webContents: WebContents): void {
  if (!isOwnRenderer(webContents)) throw new Error('Not allowed from this renderer')
}

function isOwnRenderer(webContents: WebContents): boolean {
  const url = webContents.getURL()
  return devServer ? sameOrigin(url, devServer) : url.startsWith('file:')
}

app.on('window-all-closed', () => {
  // The core server belongs to the application lifecycle, not to a renderer
  // window. A real app quit still tears down the server process.
})
