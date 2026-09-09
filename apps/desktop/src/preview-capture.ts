import path from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { BrowserWindow, Session } from 'electron'
import type {
  PreviewCaptureRequest,
  PreviewCaptureResult,
  PreviewDomAudit,
  PreviewScreenshot,
} from '@harness/contracts'
import { clearPreviewSession } from './preview-session.js'
import { PREVIEW_DOM_AUDIT_SCRIPT } from './preview-dom-audit.js'
import { allowsPreviewNavigation } from './preview-navigation.js'
import {
  PREVIEW_PAGE_HEIGHT_SCRIPT,
  PREVIEW_SETTLE_SCRIPT,
  previewCaptureHeight,
} from './preview-settle.js'

const CAPTURE_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 2_000
const MAX_PENDING_CAPTURES = 8
const MAX_EARLY_CANCELLATIONS = 32
const ISOLATED_WORLD = 1001

type CaptureJob = {
  request: PreviewCaptureRequest
  controller: AbortController
  timer: NodeJS.Timeout
  resolve: (result: PreviewCaptureResult) => void
}
type CaptureRegistration = {
  controller: AbortController
  value: unknown
  requestId: string | undefined
}

type Dependencies = {
  createWindow: (request: PreviewCaptureRequest) => BrowserWindow
  releaseWindow: (window: BrowserWindow) => void
  directory: (requestId: string) => string
  parseAudit: (value: unknown) => Promise<PreviewDomAudit>
  files?: { mkdir: typeof mkdir; rm: typeof rm; writeFile: typeof writeFile }
  timeoutMs?: number
  cleanupTimeoutMs?: number
}

function failure(requestId: string, error: unknown): PreviewCaptureResult {
  return {
    status: 'failed',
    requestId,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
  }
}

/** The thunk cannot start after cancellation; late settlement cannot resume the capture. */
async function whileActive<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    const result = await Promise.race([operation(), cancelled])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Preview cleanup timed out')),
    timeoutMs,
  )
  try {
    return await whileActive(operation, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** The fixed Chromium partition has one owner, including while cleanup is pending. */
export class PreviewCaptureOwner {
  readonly #jobs = new Map<string, CaptureJob>()
  readonly #queue: CaptureJob[] = []
  readonly #registrations = new Set<CaptureRegistration>()
  readonly #earlyCancellations = new Map<string, number>()
  #active: CaptureJob | undefined
  #unusable: Error | undefined
  #cancellationEpoch = 0

  constructor(private readonly dependencies: Dependencies) {}

  async captureAfterValidation(
    value: unknown,
    loadValidator: () => Promise<(value: unknown) => PreviewCaptureRequest>,
    canCapture: () => boolean,
  ): Promise<PreviewCaptureResult> {
    if (!canCapture()) throw new Error('Preview capture requires a live app renderer')
    const requestId =
      typeof value === 'object' &&
      value !== null &&
      'requestId' in value &&
      typeof value.requestId === 'string' &&
      value.requestId.length <= 64
        ? value.requestId
        : undefined
    if (this.#jobs.size + this.#registrations.size >= MAX_PENDING_CAPTURES) {
      const error = new Error('Preview capture queue is full')
      if (requestId) return failure(requestId, error)
      throw error
    }
    const epoch = this.#cancellationEpoch
    const deadline = Date.now() + (this.dependencies.timeoutMs ?? CAPTURE_TIMEOUT_MS)
    const controller = new AbortController()
    const registration = { controller, value, requestId }
    // The loader returns a parser, so a stalled import never closes over the
    // request. Cancellation clears the only retained raw-input slot below.
    value = undefined
    this.#registrations.add(registration)
    const timer = setTimeout(
      () => controller.abort(new Error('Preview capture timed out')),
      Math.max(0, deadline - Date.now()),
    )
    try {
      const validate = await whileActive(loadValidator, controller.signal)
      // Last-window close can cancel an IPC call before it registers a job.
      if (epoch !== this.#cancellationEpoch || !canCapture())
        controller.abort(new Error('Preview capture cancelled'))
      controller.signal.throwIfAborted()
      const request = validate(registration.value)
      registration.value = undefined
      this.#registrations.delete(registration)
      clearTimeout(timer)
      return this.#capture(request, deadline - Date.now())
    } catch (error) {
      if (controller.signal.aborted && requestId) return failure(requestId, error)
      throw error
    } finally {
      clearTimeout(timer)
      registration.value = undefined
      this.#registrations.delete(registration)
    }
  }

  capture(request: PreviewCaptureRequest): Promise<PreviewCaptureResult> {
    return this.#capture(request, this.dependencies.timeoutMs ?? CAPTURE_TIMEOUT_MS)
  }

  #capture(request: PreviewCaptureRequest, timeoutMs: number): Promise<PreviewCaptureResult> {
    if (timeoutMs <= 0)
      return Promise.resolve(failure(request.requestId, new Error('Preview capture timed out')))
    const cancelledUntil = this.#earlyCancellations.get(request.requestId)
    if (cancelledUntil !== undefined && cancelledUntil > Date.now()) {
      return Promise.resolve(failure(request.requestId, new Error('Preview capture cancelled')))
    }
    this.#earlyCancellations.delete(request.requestId)
    if (this.#unusable) return Promise.resolve(failure(request.requestId, this.#unusable))
    if (this.#jobs.has(request.requestId)) {
      return Promise.resolve(failure(request.requestId, new Error('Duplicate preview capture')))
    }
    if (this.#jobs.size + this.#registrations.size >= MAX_PENDING_CAPTURES) {
      return Promise.resolve(failure(request.requestId, new Error('Preview capture queue is full')))
    }
    return new Promise((resolve) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        this.cancel(request.requestId, new Error('Preview capture timed out'))
      }, timeoutMs)
      const job = { request, controller, timer, resolve }
      this.#jobs.set(request.requestId, job)
      this.#queue.push(job)
      this.#dispatch()
    })
  }

  cancel(requestId: string, reason = new Error('Preview capture cancelled')): void {
    for (const registration of this.#registrations) {
      if (registration.requestId !== requestId) continue
      registration.value = undefined
      registration.controller.abort(reason)
    }
    const job = this.#jobs.get(requestId)
    if (!job) {
      // IPC request validation can still be loading when cancellation arrives.
      // Keep a bounded tombstone so that late registration cannot revive it.
      this.#earlyCancellations.set(requestId, Date.now() + CAPTURE_TIMEOUT_MS)
      if (this.#earlyCancellations.size > MAX_EARLY_CANCELLATIONS) {
        this.#earlyCancellations.delete(this.#earlyCancellations.keys().next().value!)
      }
      return
    }
    job.controller.abort(reason)
    if (job !== this.#active) {
      this.#queue.splice(this.#queue.indexOf(job), 1)
      this.#finish(job, failure(requestId, reason))
    }
  }

  cancelAll(): void {
    this.#cancellationEpoch += 1
    for (const registration of this.#registrations) {
      registration.value = undefined
      registration.controller.abort(new Error('Preview capture cancelled'))
    }
    for (const requestId of this.#jobs.keys()) this.cancel(requestId)
  }

  #finish(job: CaptureJob, result: PreviewCaptureResult): void {
    clearTimeout(job.timer)
    this.#jobs.delete(job.request.requestId)
    job.resolve(result)
  }

  #dispatch(): void {
    if (this.#active) return
    const job = this.#queue.shift()
    if (!job) return
    if (this.#unusable) {
      this.#finish(job, failure(job.request.requestId, this.#unusable))
      this.#dispatch()
      return
    }
    this.#active = job
    void this.#run(job)
      .then((result) => this.#finish(job, result))
      .catch((error: unknown) => this.#finish(job, failure(job.request.requestId, error)))
      .finally(() => {
        this.#active = undefined
        this.#dispatch()
      })
  }

  async #run(job: CaptureJob): Promise<PreviewCaptureResult> {
    const { request, controller } = job
    const { signal } = controller
    const files = this.dependencies.files ?? { mkdir, rm, writeFile }
    const directory = this.dependencies.directory(request.requestId)
    let preview: BrowserWindow | undefined
    let previewSession: Pick<Session, 'clearStorageData' | 'clearCache'> | undefined
    let result: PreviewCaptureResult = failure(
      request.requestId,
      new Error('Preview capture failed'),
    )
    const destroy = () => {
      if (preview && !preview.isDestroyed()) preview.destroy()
    }
    signal.addEventListener('abort', destroy, { once: true })
    try {
      signal.throwIfAborted()
      preview = this.dependencies.createWindow(request)
      previewSession = preview.webContents.session
      await whileActive(() => files.mkdir(directory, { recursive: true, mode: 0o700 }), signal)
      await whileActive(() => preview!.loadURL(request.url), signal)
      if (!allowsPreviewNavigation(request.url, preview.webContents.getURL())) {
        throw new Error('Preview navigated outside its local origin')
      }
      const screenshots: PreviewScreenshot[] = []
      const captured = new Map<string, PreviewScreenshot>()
      for (const viewport of request.viewports) {
        const key = `${viewport.width}x${viewport.height}`
        const previous = captured.get(key)
        if (previous) {
          screenshots.push(previous)
          continue
        }
        signal.throwIfAborted()
        preview.setContentSize(viewport.width, viewport.height)
        const evaluate = (code: string) =>
          whileActive(
            () => preview!.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]),
            signal,
          )
        await evaluate(PREVIEW_SETTLE_SCRIPT)
        const audit = await evaluate(PREVIEW_DOM_AUDIT_SCRIPT)
        const domAudit = await whileActive(() => this.dependencies.parseAudit(audit), signal)
        const height = previewCaptureHeight(
          await evaluate(PREVIEW_PAGE_HEIGHT_SCRIPT),
          viewport.height,
        )
        const image = await whileActive(
          () => preview!.webContents.capturePage({ x: 0, y: 0, width: viewport.width, height }),
          signal,
        )
        const destination = path.join(directory, `${key}.png`)
        await whileActive(
          () => files.writeFile(destination, image.toPNG(), { flag: 'wx', mode: 0o600, signal }),
          signal,
        )
        const screenshot = { path: destination, ...viewport, domAudit }
        screenshots.push(screenshot)
        captured.set(key, screenshot)
      }
      result = { status: 'completed', requestId: request.requestId, screenshots }
    } catch (error) {
      result = failure(request.requestId, error)
    } finally {
      clearTimeout(job.timer)
      signal.removeEventListener('abort', destroy)
      // The page must stop changing shared storage before either cleanup starts.
      destroy()
      if (preview) this.dependencies.releaseWindow(preview)
      if (previewSession) {
        const sessionToClear = previewSession
        try {
          await withDeadline(
            () => clearPreviewSession(sessionToClear),
            this.dependencies.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
          )
        } catch (error) {
          // A timed-out clear may still run in Chromium. Reusing the partition,
          // even after a later successful clear, could erase the next page's data.
          this.#unusable = new Error(
            'Preview storage cleanup failed; restart the app to capture again',
          )
          result = failure(request.requestId, error)
        }
      }
      if (signal.aborted && result.status === 'completed')
        result = failure(request.requestId, signal.reason)
      if (result.status === 'failed') {
        await withDeadline(
          () => files.rm(directory, { recursive: true, force: true }),
          this.dependencies.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
        ).catch(() => undefined)
      }
    }
    return result
  }
}
