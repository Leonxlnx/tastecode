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

export class PreviewCaptureCoordinator {
  #clients = new Set<WebSocket>()
  #pending = new Map<string, PendingCapture>()

  constructor(
    private readonly send: (socket: WebSocket, request: PreviewCaptureRequest) => void,
    private readonly timeoutMs = 30_000,
  ) {}

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
  }

  capture(url: string, viewports: PreviewViewport[]): Promise<PreviewScreenshot[]> {
    const socket = this.#clients.values().next().value as WebSocket | undefined
    if (!socket) return Promise.reject(new Error('Preview capture is unavailable'))

    const request = { requestId: randomUUID(), url, viewports }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId)
        reject(new Error('Preview capture timed out'))
      }, this.timeoutMs)
      timer.unref()
      this.#pending.set(request.requestId, { socket, request, resolve, reject, timer })
      try {
        this.send(socket, request)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(request.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  complete(socket: WebSocket, result: PreviewCaptureResult): void {
    const pending = this.#pending.get(result.requestId)
    if (!pending || pending.socket !== socket) throw new Error('Unknown preview capture request')
    clearTimeout(pending.timer)
    this.#pending.delete(result.requestId)

    if (result.status === 'failed') {
      pending.reject(new Error(result.error))
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
      return
    }
    pending.resolve(result.screenshots)
  }
}
