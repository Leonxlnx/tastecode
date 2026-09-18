import { randomUUID } from 'node:crypto'
import type {
  PreviewCaptureRequest,
  PreviewCaptureResult,
  PreviewScreenshot,
  PreviewViewport,
} from '@harness/contracts'
import type { WebSocket } from 'ws'

type PendingCapture<Client extends object> = {
  socket?: Client
  request: PreviewCaptureRequest
  resolve: (screenshots: PreviewScreenshot[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type QueuedCapture<Client extends object> = Omit<PendingCapture<Client>, 'socket' | 'timer'>

export class PreviewCaptureCoordinator<Client extends object = WebSocket> {
  #clients = new Set<Client>()
  #pending = new Map<string, PendingCapture<Client>>()
  #queue: Array<QueuedCapture<Client>> = []

  constructor(
    private readonly send: (socket: Client, request: PreviewCaptureRequest) => void,
    private readonly timeoutMs = 35_000,
    private readonly cancel: (socket: Client, requestId: string) => void = () => undefined,
  ) {}

  get available(): boolean {
    return this.#clients.size > 0
  }

  setCapability(socket: Client, available: boolean): void {
    if (available) {
      this.#clients.add(socket)
      this.#dispatchNext()
    } else this.remove(socket)
  }

  remove(socket: Client): void {
    this.#clients.delete(socket)
    for (const [requestId, pending] of this.#pending) {
      if (pending.socket !== socket) continue
      this.#pending.delete(requestId)
      this.#cancel(socket, requestId)
      delete pending.socket
      // Keep the original deadline, but give the replacement native capture a
      // fresh identity so late cancellation/results cannot affect its retry.
      pending.request = { ...pending.request, requestId: randomUUID() }
      this.#pending.set(pending.request.requestId, pending)
    }
    this.#dispatchNext()
  }

  capture(url: string, viewports: PreviewViewport[]): Promise<PreviewScreenshot[]> {
    if (!this.available) return Promise.reject(new Error('Preview capture is unavailable'))
    if (this.#queue.length >= 16) return Promise.reject(new Error('Preview capture queue is full'))

    const request = { requestId: randomUUID(), url, viewports }
    return new Promise((resolve, reject) => {
      this.#queue.push({ request, resolve, reject })
      this.#dispatchNext()
    })
  }

  complete(socket: Client, result: PreviewCaptureResult): void {
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
    const interrupted = this.#pending.values().next().value
    if (interrupted?.socket || (!interrupted && this.#queue.length === 0)) return
    let socket: Client | undefined
    for (const client of this.#clients) {
      socket = client
      break
    }
    if (!socket) {
      if (interrupted) return
      for (const queued of this.#queue.splice(0)) {
        queued.reject(new Error('Preview capture client disconnected'))
      }
      return
    }
    if (interrupted) {
      interrupted.socket = socket
      try {
        this.send(socket, interrupted.request)
      } catch {
        this.remove(socket)
      }
      return
    }
    const queued = this.#queue.shift()!
    const timer = setTimeout(() => {
      this.#pending.delete(pending.request.requestId)
      if (pending.socket) this.#cancel(pending.socket, pending.request.requestId)
      queued.reject(new Error('Preview capture timed out'))
      this.#dispatchNext()
    }, this.timeoutMs)
    timer.unref()
    const pending = { socket, timer, ...queued }
    this.#pending.set(queued.request.requestId, pending)
    try {
      this.send(socket, queued.request)
    } catch {
      this.remove(socket)
    }
  }

  #cancel(socket: Client, requestId: string): void {
    try {
      this.cancel(socket, requestId)
    } catch {
      // A disconnected client cannot receive cancellation. Its own bounded
      // capture lifetime still releases the window and isolated session.
    }
  }
}
