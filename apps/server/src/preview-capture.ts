import { randomUUID } from 'node:crypto'
import type {
  PreviewCaptureRequest,
  PreviewCaptureResult,
  PreviewScreenshot,
  PreviewViewport,
} from '@harness/contracts'
import type { WebSocket } from 'ws'

type PendingCapture = {
  socket: WebSocket
  request: PreviewCaptureRequest
  resolve: (screenshots: PreviewScreenshot[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type QueuedCapture = Omit<PendingCapture, 'socket' | 'timer'>

export class PreviewCaptureCoordinator {
  #clients = new Set<WebSocket>()
  #pending = new Map<string, PendingCapture>()
  #queue: QueuedCapture[] = []

  constructor(
    private readonly send: (socket: WebSocket, request: PreviewCaptureRequest) => void,
    private readonly timeoutMs = 35_000,
  ) {}

  get available(): boolean {
    return this.#clients.size > 0
  }

  setCapability(socket: WebSocket, available: boolean): void {
    if (available) this.#clients.add(socket)
    else this.remove(socket)
  }

  remove(socket: WebSocket): void {
    this.#clients.delete(socket)
    for (const [requestId, pending] of this.#pending) {
      if (pending.socket !== socket) continue
      clearTimeout(pending.timer)
      this.#pending.delete(requestId)
      pending.reject(new Error('Preview capture client disconnected'))
    }
    this.#dispatchNext()
  }

  capture(url: string, viewports: PreviewViewport[]): Promise<PreviewScreenshot[]> {
    if (!this.available) return Promise.reject(new Error('Preview capture is unavailable'))

    const request = { requestId: randomUUID(), url, viewports }
    return new Promise((resolve, reject) => {
      this.#queue.push({ request, resolve, reject })
      this.#dispatchNext()
    })
  }

  complete(socket: WebSocket, result: PreviewCaptureResult): void {
    const pending = this.#pending.get(result.requestId)
    if (!pending || pending.socket !== socket) throw new Error('Unknown preview capture request')
    clearTimeout(pending.timer)
    this.#pending.delete(result.requestId)

    if (result.status === 'failed') {
      pending.reject(new Error(result.error))
      this.#dispatchNext()
      return
    }
    if (
      result.screenshots.length !== pending.request.viewports.length ||
      result.screenshots.some((screenshot, index) => {
        const viewport = pending.request.viewports[index]
        return (
          !viewport || screenshot.width !== viewport.width || screenshot.height !== viewport.height
        )
      })
    ) {
      pending.reject(new Error('Preview capture returned unexpected viewports'))
      this.#dispatchNext()
      return
    }
    pending.resolve(result.screenshots)
    this.#dispatchNext()
  }

  #dispatchNext(): void {
    if (this.#pending.size > 0 || this.#queue.length === 0) return
    const socket = this.#clients.values().next().value as WebSocket | undefined
    if (!socket) {
      for (const queued of this.#queue.splice(0)) {
        queued.reject(new Error('Preview capture client disconnected'))
      }
      return
    }
    const queued = this.#queue.shift()!
    const timer = setTimeout(() => {
      this.#pending.delete(queued.request.requestId)
      queued.reject(new Error('Preview capture timed out'))
      this.#dispatchNext()
    }, this.timeoutMs)
    timer.unref()
    this.#pending.set(queued.request.requestId, { socket, timer, ...queued })
    try {
      this.send(socket, queued.request)
    } catch (error) {
      clearTimeout(timer)
      this.#pending.delete(queued.request.requestId)
      queued.reject(error instanceof Error ? error : new Error(String(error)))
      this.#dispatchNext()
    }
  }
}
