import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
  type WebContents,
} from 'electron'
import { allowsMicrophoneRequest } from './media-permissions.js'

/**
 * Electron shell. Deliberately thin: it opens a window and nothing else.
 *
 * All privileged work — spawning agents, filesystem, credentials — lives in the
 * core server. The renderer talks to that over WebSocket, exactly like the web
 * and (later) mobile clients do. That is what keeps those surfaces from being a
 * rewrite. See docs/ARCHITECTURE.md.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const devServer = process.env['HARNESS_DEV_SERVER']
const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#131313',
    // Draw our own top bar, but keep native window controls on Windows.
    titleBarStyle: 'hidden',
    // Height and colour must match --titlebar-h and --bg-rail in the renderer's
    // tokens. Windows sizes the caption buttons from this number, so if the two
    // drift the buttons stand taller than the bar they sit in — which is
    // invisible until someone screenshots it.
    titleBarOverlay: { color: '#131313', symbolColor: '#a3a3a3', height: 34 },
    show: false,
    webPreferences: {
      // Hardened from the first commit, not "later". The renderer gets no
      // general native access; its small preload bridge exposes only native
      // UI and tightly validated clipboard operations.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(here, 'preload.cjs'),
    },
  })

  // Avoid the white flash before React paints.
  window.once('ready-to-show', () => window.show())

  // Nothing in this app should ever open a second window, and any external
  // link belongs in the user's browser, not in a chromeless Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devServer !== undefined && url.startsWith(devServer)
    if (!allowed) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadFile(path.join(here, '../../web/dist/index.html'))
  }
}

/**
 * Native pickers. The renderer can ask for a path but never reads the disk
 * itself — the user's own selection is the only way a path enters the app.
 */
ipcMain.handle('harness:pickFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a project folder',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

ipcMain.handle('harness:pickSkillFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose an Agent Skill folder',
  })
  return result.canceled ? undefined : result.filePaths[0]
})

ipcMain.handle('harness:pickFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('harness:savePastedImage', async (_event, payload: unknown) => {
  const image = pastedImage(payload)
  const directory = path.join(app.getPath('temp'), 'Personal Harness', 'pasted-images')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = path.join(directory, `pasted-${randomUUID()}${image.extension}`)
  await writeFile(destination, image.bytes, { flag: 'wx', mode: 0o600 })
  return destination
})

void app.whenReady().then(() => {
  configureMediaPermissions()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** Allow this app's own renderer to request audio, never video or another origin. */
function configureMediaPermissions(): void {
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

function isOwnRenderer(webContents: WebContents): boolean {
  const url = webContents.getURL()
  return devServer ? url.startsWith(devServer) : url.startsWith('file:')
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
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
