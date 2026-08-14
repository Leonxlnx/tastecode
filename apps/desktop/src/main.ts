import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  session,
  shell,
  systemPreferences,
  Tray,
  type Event as ElectronEvent,
  type WebContents,
} from 'electron'
import {
  PreviewDomAuditSchema,
  PreviewCaptureRequestSchema,
  type PreviewCaptureRequest,
  type PreviewCaptureResult,
} from '@harness/contracts'
import { shouldHideWindowOnClose } from './background-lifecycle.js'
import { clipboardText } from './clipboard-text.js'
import { browserGuestUrl, configureEmbeddedBrowser } from './embedded-browser.js'
import { isMacHapticPattern, MacOSHaptics } from './macos-haptics.js'
import { allowsMicrophoneRequest } from './media-permissions.js'
import { allowsPreviewNavigation } from './preview-navigation.js'
import { pastedFile } from './pasted-file.js'
import { revealablePath } from './reveal-path.js'
import { projectFilePath } from './project-file-path.js'
import { PREVIEW_DOM_AUDIT_SCRIPT } from './preview-dom-audit.js'
import { clearPreviewSession } from './preview-session.js'
import { PREVIEW_SETTLE_SCRIPT } from './preview-settle.js'
import { ServerSupervisor } from './server-supervisor.js'
import { restoreMainWindowPresence } from './window-presence.js'
import { startVisibilityWatchdog } from './window-visibility-watchdog.js'
import { windowThemeOptions, windowThemeSource } from './window-theme.js'
import { isZoomAction, nextZoomFactor, type ZoomAction, zoomShortcut } from './zoom-shortcuts.js'

/**
 * Electron shell. Deliberately thin: it opens a window and nothing else.
 *
 * All privileged work — spawning agents, filesystem, credentials — lives in the
 * core server. The renderer talks to that over WebSocket, which keeps the
 * browser and desktop surfaces on the same protocol. See docs/ARCHITECTURE.md.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const productIconPath = path.join(here, '../assets/tastecode-icon.png')

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
/** Hidden capture windows are real BrowserWindows; lifecycle checks that count
 *  "the app's windows" must not count them. */
const captureWindows = new Set<BrowserWindow>()
const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024
// Windows' native occlusion tracker can wrongly decide the window is fully
// covered and stick there: the page keeps running with visibilityState
// 'hidden' while the window shows nothing but its background colour — the
// intermittent all-black window. Verified over CDP: DOM complete, renderer
// healthy, compositor off. The watchdog below covers whatever this misses.
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.tastecode.desktop')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}
app.setName('TasteCode')
// Diagnostics for the field: software rendering and a DevTools port, both
// opt-in via environment so a broken machine can be inspected.
if (process.env['HARNESS_DISABLE_GPU'] === '1') app.disableHardwareAcceleration()
if (process.env['HARNESS_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['HARNESS_DEBUG_PORT'])
}

const ownsSingleInstance = app.requestSingleInstanceLock()
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let appIsQuitting = false
let serverSupervisor: ServerSupervisor | undefined
const macOSHaptics = new MacOSHaptics()

if (!ownsSingleInstance) {
  console.error('[desktop] another TasteCode instance owns the single-instance lock')
  app.quit()
}

/**
 * Outside development the shell owns its core server: without this a packaged
 * app has nothing listening on the socket and every feature sits behind a
 * permanent "Reconnecting…". In dev, dev.js runs the server with a watcher and
 * signals that through HARNESS_DEV_SERVER.
 *
 * The child is this same Electron binary in Node mode — the one runtime an
 * installed app is guaranteed to carry, with the Node version the server was
 * built against.
 */
function startOwnedServer(): void {
  if (devServer || serverSupervisor) return
  const serverEntry = app.isPackaged
    ? require.resolve('@harness/server')
    : path.join(here, '../../server/dist/main.js')
  serverSupervisor = new ServerSupervisor({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    onLog: (line) => console.log('[server]', line),
    onGaveUp: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'TasteCode',
          message: 'The core server keeps crashing.',
          detail: 'Restart the app. If this keeps happening, reinstall it.',
        })
      }
    },
  })
  serverSupervisor.start()
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  const initialTheme = windowThemeOptions('dark')
  const window = new BrowserWindow({
    icon: productIconPath,
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    focusable: true,
    movable: true,
    skipTaskbar: false,
    backgroundColor: initialTheme.backgroundColor,
    // Real glass, the way Codex does it: the OS draws its blur material
    // behind the window, and the renderer keeps every surface opaque except
    // the sidebar column, which is where the material shows through. CSS
    // backdrop-filter cannot do this — inside the page there is nothing
    // behind the sidebar to blur.
    ...(process.platform === 'win32' ? { backgroundMaterial: 'acrylic' as const } : {}),
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
      preload: path.join(here, 'preload.cjs'),
    },
  })
  mainWindow = window
  configureEmbeddedBrowser(window.webContents)
  restoreMainWindowPresence(process.platform, app, window)
  const stopWatchdog = startVisibilityWatchdog(window, (line) => console.warn('[desktop]', line))
  window.on('closed', stopWatchdog)

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
  })
  window.on('responsive', () => {
    console.info('[desktop] main window renderer recovered')
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[desktop] main window renderer exited: ${details.reason} (code ${details.exitCode})`,
    )
  })

  // Avoid the white flash before React paints.
  window.once('ready-to-show', showMainWindow)

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
      for (const capture of [...captureWindows]) capture.destroy()
    }
  })

  if (devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadFile(
      app.isPackaged
        ? path.join(process.resourcesPath, 'web', 'index.html')
        : path.join(here, '../../web/dist/index.html'),
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
  tray.setToolTip('TasteCode')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open TasteCode', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit TasteCode', click: () => app.quit() },
    ]),
  )
  tray.on('click', showMainWindow)
}

ipcMain.handle('harness:setZoom', (event, action: unknown) => {
  requireOwnRenderer(event.sender)
  if (!isZoomAction(action)) throw new Error('Invalid zoom action')
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No window for zoom action')
  applyZoom(window, action)
})

ipcMain.handle('harness:setTheme', (event, preference: unknown) => {
  requireOwnRenderer(event.sender)
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No window for theme change')
  nativeTheme.themeSource = windowThemeSource(preference)
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
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

ipcMain.handle('harness:capturePreview', async (event, value: unknown) => {
  if (!isOwnRenderer(event.sender)) throw new Error('Preview capture requires the app renderer')
  const parsed = PreviewCaptureRequestSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid preview capture request')
  return capturePreview(parsed.data)
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

async function capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureResult> {
  const directory = path.join(
    app.getPath('temp'),
    'TasteCode',
    'preview-captures',
    request.requestId,
  )
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
      // One fixed partition, cleared after every run. A partition per request
      // would leave Electron's session registry holding a live session (and
      // its network stack) per capture for the life of the process.
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

  // A pending webfont or a throttled hidden renderer can stall the settle
  // script forever; the whole capture races a hard deadline instead of
  // leaving a hidden BrowserWindow alive and the caller's promise pending.
  let deadlineTimer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('preview capture timed out')), 30_000)
    deadlineTimer.unref?.()
  })
  // Until the first race attaches a handler, a firing deadline would be an
  // unhandled rejection — fatal in the main process — e.g. when mkdir throws.
  deadline.catch(() => undefined)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await Promise.race([preview.loadURL(request.url), deadline])
    if (!allowsPreviewNavigation(request.url, preview.webContents.getURL())) {
      throw new Error('preview navigated outside its local origin')
    }
    const screenshots = []
    // Duplicate viewports would collide on the wx-flagged filename and fail
    // the entire request.
    const seen = new Set<string>()
    for (const viewport of request.viewports) {
      const key = `${viewport.width}x${viewport.height}`
      if (seen.has(key)) continue
      seen.add(key)
      preview.setContentSize(viewport.width, viewport.height)
      await Promise.race([preview.webContents.executeJavaScript(PREVIEW_SETTLE_SCRIPT), deadline])
      const domAudit = PreviewDomAuditSchema.parse(
        await Promise.race([
          preview.webContents.executeJavaScriptInIsolatedWorld(1001, [
            { code: PREVIEW_DOM_AUDIT_SCRIPT },
          ]),
          deadline,
        ]),
      )
      const destination = path.join(directory, `${key}.png`)
      await writeFile(destination, (await preview.webContents.capturePage()).toPNG(), {
        flag: 'wx',
        mode: 0o600,
      })
      screenshots.push({ path: destination, ...viewport, domAudit })
    }
    return { status: 'completed', requestId: request.requestId, screenshots }
  } catch (error) {
    // Nothing consumes a failed capture's directory; leaving it accumulates.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    return {
      status: 'failed',
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(deadlineTimer)
    // The closed-last-window handler may have destroyed us already; touching
    // a destroyed webContents throws, which would eat a successful result.
    if (!preview.isDestroyed() && !preview.webContents.isDestroyed()) preview.destroy()
    captureWindows.delete(preview)
    // The fixed partition is shared by every capture, so the IPC must not
    // resolve until both browser storage and the HTTP cache are clean.
    await clearPreviewSession(previewSession)
  }
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
 * Native pickers. The renderer can ask for a path but never reads the disk
 * itself — the user's own selection is the only way a path enters the app.
 */
ipcMain.handle('harness:pickFolder', async (event) => {
  requireOwnRenderer(event.sender)
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a project folder',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

ipcMain.handle('harness:pickSkillFolder', async (event) => {
  requireOwnRenderer(event.sender)
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose an Agent Skill folder',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

ipcMain.handle('harness:pickFiles', async (event) => {
  requireOwnRenderer(event.sender)
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
  })
  return result.canceled ? [] : result.filePaths
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
  return destination
})

if (ownsSingleInstance) {
  app.on('second-instance', showMainWindow)
  app.on('before-quit', () => {
    appIsQuitting = true
  })
  app.on('will-quit', () => {
    macOSHaptics.stop()
    serverSupervisor?.stop()
    serverSupervisor = undefined
    tray?.destroy()
    tray = undefined
  })

  void app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(productIconPath)
    startOwnedServer()
    configureMediaPermissions()
    void sweepStaleCaptures()
    createWindow()
    createBackgroundTray()
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

/** Allow this app's own renderer to request audio, never video or another origin. */
function configureMediaPermissions(): void {
  // Chromium's synchronous check path (navigator.permissions.query, device
  // enumeration) never consults the request handler below and defaults to
  // permissive, so it needs its own answer.
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) =>
      permission === 'media' && webContents !== null && isOwnRenderer(webContents),
  )
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (
        permission !== 'media' ||
        !isOwnRenderer(webContents) ||
        !allowsMicrophoneRequest(details)
      ) {
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
