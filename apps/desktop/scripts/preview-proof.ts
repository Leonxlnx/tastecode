import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain, nativeImage, session } from 'electron'
import {
  PreviewCaptureRequestSchema,
  PreviewDomAuditSchema,
  type PreviewCaptureRequest,
  type PreviewCaptureResult,
} from '@harness/contracts'
import { PreviewCaptureOwner } from '../src/preview-capture.js'

const directory = process.env['HARNESS_PREVIEW_PROOF_DATA']!
const report = process.env['HARNESS_PREVIEW_PROOF_REPORT']!
app.setPath('userData', path.join(directory, 'profile'))
app.setPath('sessionData', path.join(directory, 'profile'))
const active = new Set<BrowserWindow>()
let maximumActive = 0
let captureWindowsCreated = 0
let controller: BrowserWindow | undefined
let owner: PreviewCaptureOwner
let validationPause: Promise<void> | undefined
let onValidationStarted: (() => void) | undefined
let lastCapture: Promise<PreviewCaptureResult> | undefined
let observedPageMath: number | undefined
let nativeRect: Electron.Rectangle | undefined
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  if (request.url === '/pending') {
    response.write('<!doctype html><p>Pending')
    return
  }
  response.end(`<!doctype html><html><body style="height:640px"><h1>Preview capture proof</h1>
    <script>Math.min = () => 100000000; localStorage.setItem('preview-proof', 'dirty');</script>
  </body></html>`)
})
const deadline = setTimeout(() => {
  console.error('Preview proof timed out')
  app.exit(1)
}, 15_000)
app.on('window-all-closed', () => {})

function createOwner(timeoutMs = 2_000): PreviewCaptureOwner {
  return new PreviewCaptureOwner({
    createWindow() {
      captureWindowsCreated += 1
      const window = new BrowserWindow({
        width: 320,
        height: 240,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          partition: 'preview-proof',
        },
      })
      active.add(window)
      maximumActive = Math.max(maximumActive, active.size)
      const capturePage = window.webContents.capturePage.bind(window.webContents)
      window.webContents.capturePage = async (rect) => {
        nativeRect = rect
        observedPageMath = await window.webContents.executeJavaScript('Math.min(12000, 100000000)')
        return capturePage(rect)
      }
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      return window
    },
    releaseWindow(window) {
      active.delete(window)
    },
    directory: (id) => path.join(directory, 'captures', id),
    parseAudit: async (value) => PreviewDomAuditSchema.parse(value),
    timeoutMs,
    cleanupTimeoutMs: 1_000,
  })
}

async function capture(url: string): Promise<PreviewCaptureResult> {
  const request: PreviewCaptureRequest = {
    requestId: randomUUID(),
    url,
    viewports: [{ width: 320, height: 240 }],
  }
  return controller!.webContents.executeJavaScript(
    `window.harness.capturePreview(${JSON.stringify(request)})`,
  )
}

async function main() {
  await app.whenReady()
  await mkdir(report, { recursive: true })
  const html = path.join(directory, 'controller.html')
  await writeFile(html, '<!doctype html><title>Preview capture IPC proof</title>')
  controller = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: process.env['HARNESS_PREVIEW_PROOF_PRELOAD']!,
    },
  })
  controller.on('closed', () => {
    if (BrowserWindow.getAllWindows().filter((window) => !active.has(window)).length === 0)
      owner?.cancelAll()
  })
  ipcMain.handle('harness:capturePreview', (event, value: unknown) => {
    lastCapture = owner.captureAfterValidation(
      value,
      async () => {
        onValidationStarted?.()
        await validationPause
        return (input) => PreviewCaptureRequestSchema.parse(input)
      },
      () => !event.sender.isDestroyed() && event.sender === controller?.webContents,
    )
    return lastCapture
  })
  await controller.loadFile(html)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local proof port')
  const url = `http://127.0.0.1:${address.port}`
  owner = createOwner()
  const first = await capture(url)
  assert.equal(first.status, 'completed')
  assert.equal(observedPageMath, 100_000_000)
  assert.ok(nativeRect && nativeRect.height <= 12_000 && nativeRect.height >= 240)
  const image = nativeImage.createFromPath(first.screenshots[0]!.path)
  assert.ok(!image.isEmpty() && image.getSize().height <= 12_000)
  await copyFile(first.screenshots[0]!.path, path.join(report, 'preview.png'))

  const previewSession = session.fromPartition('preview-proof')
  const clearStorage = previewSession.clearStorageData.bind(previewSession)
  const clearCache = previewSession.clearCache.bind(previewSession)
  let cacheAttempts = 0
  previewSession.clearStorageData = async () => {
    throw new Error('Injected storage failure')
  }
  previewSession.clearCache = async () => {
    cacheAttempts += 1
    await clearCache()
  }
  owner = createOwner()
  const cleanupFailure = await capture(url)
  assert.equal(cleanupFailure.status, 'failed')
  assert.equal(cacheAttempts, 1)
  const refused = await capture(url)
  assert.equal(refused.status, 'failed')
  assert.equal(cacheAttempts, 1)
  previewSession.clearStorageData = clearStorage
  previewSession.clearCache = clearCache
  await Promise.all([clearStorage(), clearCache()])

  owner = createOwner(500)
  const started = performance.now()
  const timeout = await capture(`${url}/pending`)
  assert.equal(timeout.status, 'failed')
  assert.ok(performance.now() - started < 2_000)
  assert.equal(active.size, 0)
  const afterTimeout = await capture(url)
  assert.equal(afterTimeout.status, 'completed')
  assert.equal(maximumActive, 1)
  assert.equal(active.size, 0)

  // Exercise the real preload IPC while its main-process validation is paused.
  // Closing the last app window must cancel that unregistered request too.
  let releaseValidation!: () => void
  validationPause = new Promise<void>((resolve) => {
    releaseValidation = resolve
  })
  const validationStarted = new Promise<void>((resolve) => {
    onValidationStarted = resolve
  })
  const windowsBeforeClose = captureWindowsCreated
  void capture(url).catch(() => undefined)
  await validationStarted
  controller.destroy()
  const cancelledBeforeRegistration = await lastCapture
  assert.equal(cancelledBeforeRegistration?.status, 'failed')
  releaseValidation()
  await Promise.resolve()
  assert.equal(captureWindowsCreated, windowsBeforeClose)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  await writeFile(
    path.join(report, 'preview-proof.json'),
    JSON.stringify(
      {
        F17: 'PASS',
        F18: 'PASS',
        R3: 'PASS',
        observedPageMath,
        nativeRect,
        png: image.getSize(),
        cacheAttempts,
        maximumActive,
        timeout,
        cleanupFailure,
        cancelledBeforeRegistration,
      },
      null,
      2,
    ),
  )
  console.log('PASS F17 F18 R3: native Electron and preload IPC')
}

void main()
  .then(
    () => 0,
    (error: unknown) => {
      console.error(error)
      return 1
    },
  )
  .then(async (code) => {
    clearTimeout(deadline)
    owner?.cancelAll()
    for (const window of active) if (!window.isDestroyed()) window.destroy()
    if (controller && !controller.isDestroyed()) controller.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.exit(code)
  })
