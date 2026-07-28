import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

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
      // native access at all: it has no preload bridge because it does not
      // need one — everything goes through the server socket.
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

ipcMain.handle('harness:pickFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
  })
  return result.canceled ? [] : result.filePaths
})

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
