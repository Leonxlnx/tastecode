import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  systemPreferences,
  Tray,
  type WebContents,
} from 'electron'
import {
  PreviewCaptureRequestSchema,
  type PreviewCaptureRequest,
  type PreviewCaptureResult,
} from '@harness/contracts'
import { shouldHideWindowOnClose } from './background-lifecycle.js'
import { allowsMicrophoneRequest } from './media-permissions.js'
import { allowsPreviewNavigation } from './preview-navigation.js'
import { revealablePath } from './reveal-path.js'
import { windowThemeOptions } from './window-theme.js'
import { isZoomAction, nextZoomFactor, type ZoomAction, zoomShortcut } from './zoom-shortcuts.js'

/**
 * Electron shell. Deliberately thin: it opens a window and nothing else.
 *
 * All privileged work — spawning agents, filesystem, credentials — lives in the
 * core server. The renderer talks to that over WebSocket, exactly like the web
 * and (later) mobile clients do. That is what keeps those surfaces from being a
 * rewrite. See docs/ARCHITECTURE.md.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

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
const CAPTURE_SETTLE_SCRIPT = `new Promise(resolve => requestAnimationFrame(resolve))
  .then(() => Promise.race([
    Promise.allSettled(document.getAnimations().map(animation => animation.finished)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]))
  .then(() => document.fonts?.ready)
  .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`
const ownsSingleInstance = app.requestSingleInstanceLock()
let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let appIsQuitting = false

if (!ownsSingleInstance) app.quit()

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  const initialTheme = windowThemeOptions('dark')
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
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
      // Defaults to on, which loads Chromium's spellcheck service and
      // downloads Hunspell dictionaries at first run — the only network
      // traffic the app would ever do outside the renderer's own CSP.
      spellcheck: false,
      preload: path.join(here, 'preload.cjs'),
    },
  })
  mainWindow = window

  window.on('close', (event) => {
    if (!shouldHideWindowOnClose(process.platform, appIsQuitting)) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })

  // Avoid the white flash before React paints.
  window.once('ready-to-show', () => window.show())

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
    void window.loadFile(path.join(here, '../../web/dist/index.html'))
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
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createBackgroundTray(): void {
  if (process.platform === 'darwin' || tray) return
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="8" fill="#111113"/>',
    '<path fill="#fff" d="M8 8h4v6h8V8h4v16h-4v-6h-8v6H8z"/>',
    '</svg>',
  ].join('')
  const icon = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: 20, height: 20 })
  tray = new Tray(icon)
  tray.setToolTip('Harness')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Harness', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit Harness', click: () => app.quit() },
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

ipcMain.handle('harness:setTheme', (event, theme: unknown) => {
  requireOwnRenderer(event.sender)
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No window for theme change')
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

ipcMain.handle('harness:capturePreview', async (event, value: unknown) => {
  if (!isOwnRenderer(event.sender)) throw new Error('Preview capture requires the app renderer')
  const parsed = PreviewCaptureRequestSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid preview capture request')
  return capturePreview(parsed.data)
})

function applyZoom(window: BrowserWindow, action: ZoomAction): void {
  const factor = nextZoomFactor(window.webContents.getZoomFactor(), action)
  window.webContents.setZoomFactor(factor)
  window.webContents.send('harness:zoomChanged', factor)
}

async function capturePreview(request: PreviewCaptureRequest): Promise<PreviewCaptureResult> {
  const directory = path.join(
    app.getPath('temp'),
    'Personal Harness',
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

  preview.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  preview.webContents.on('will-navigate', (event, url) => {
    if (!allowsPreviewNavigation(request.url, url)) event.preventDefault()
  })

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
    const screenshots = []
    // Duplicate viewports would collide on the wx-flagged filename and fail
    // the entire request.
    const seen = new Set<string>()
    for (const viewport of request.viewports) {
      const key = `${viewport.width}x${viewport.height}`
      if (seen.has(key)) continue
      seen.add(key)
      preview.setContentSize(viewport.width, viewport.height)
      await Promise.race([preview.webContents.executeJavaScript(CAPTURE_SETTLE_SCRIPT), deadline])
      const destination = path.join(directory, `${key}.png`)
      await writeFile(destination, (await preview.webContents.capturePage()).toPNG(), {
        flag: 'wx',
        mode: 0o600,
      })
      screenshots.push({ path: destination, ...viewport })
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
    if (!preview.isDestroyed() && !preview.webContents.isDestroyed()) {
      const previewSession = preview.webContents.session
      preview.destroy()
      void previewSession.clearStorageData().catch(() => undefined)
    }
    captureWindows.delete(preview)
  }
}

/** Screenshot directories older than a day have no consumer left — the design
 *  flow reads them within seconds of the capture. */
async function sweepStaleCaptures(): Promise<void> {
  const root = path.join(app.getPath('temp'), 'Personal Harness', 'preview-captures')
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

ipcMain.handle('harness:savePastedImage', async (event, payload: unknown) => {
  requireOwnRenderer(event.sender)
  const image = pastedImage(payload)
  const directory = path.join(app.getPath('temp'), 'Personal Harness', 'pasted-images')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = path.join(directory, `pasted-${randomUUID()}${image.extension}`)
  await writeFile(destination, image.bytes, { flag: 'wx', mode: 0o600 })
  return destination
})

if (ownsSingleInstance) {
  app.on('second-instance', showMainWindow)
  app.on('before-quit', () => {
    appIsQuitting = true
  })
  app.on('will-quit', () => {
    tray?.destroy()
    tray = undefined
  })

  void app.whenReady().then(() => {
    configureMediaPermissions()
    void sweepStaleCaptures()
    createWindow()
    createBackgroundTray()
    app.on('activate', showMainWindow)
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
  // window. A real app quit still tears down the process and its mobile socket.
})

function pastedImage(payload: unknown): { bytes: Buffer; extension: string } {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid pasted image')

  const candidate = payload as { type?: unknown; bytes?: unknown }
  if (typeof candidate.type !== 'string') throw new Error('Invalid pasted image type')

  const bytes =
    candidate.bytes instanceof ArrayBuffer
      ? Buffer.from(candidate.bytes)
      : ArrayBuffer.isView(candidate.bytes)
        ? Buffer.from(
            candidate.bytes.buffer,
            candidate.bytes.byteOffset,
            candidate.bytes.byteLength,
          )
        : undefined

  if (!bytes || bytes.length === 0 || bytes.length > MAX_PASTED_IMAGE_BYTES) {
    throw new Error('Pasted image is empty or too large')
  }

  const extension = imageExtension(candidate.type, bytes)

  if (!extension) throw new Error('Unsupported pasted image')
  return { bytes, extension }
}

function imageExtension(type: string, bytes: Buffer): string | undefined {
  if (type === 'image/png' && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return '.png'
  }
  if (type === 'image/jpeg' && hasPrefix(bytes, [0xff, 0xd8, 0xff])) return '.jpg'
  if (type === 'image/gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return '.gif'
  }
  if (
    type === 'image/webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp'
  }
  if (type === 'image/bmp' && bytes.subarray(0, 2).toString('ascii') === 'BM') return '.bmp'
  return undefined
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}
