// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewCaptureResult } from '@harness/contracts'
import { Transport } from './transport.js'

const native = vi.hoisted(() => ({ capture: vi.fn(), cancel: vi.fn(async () => {}) }))
vi.mock('./bridge.js', () => ({
  canCapturePreview: true,
  capturePreview: native.capture,
  cancelPreviewCapture: native.cancel,
  reportStartupMilestone() {},
}))
class Socket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static last: Socket
  readyState = 0
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  sent: string[] = []
  constructor() {
    Socket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('preview capture transport lifetime', () => {
  it.each(['cancel push', 'disconnect'])(
    'cancels native work on %s and does not publish late results',
    async (action) => {
      vi.stubGlobal('WebSocket', Socket)
      let finish!: (result: PreviewCaptureResult) => void
      native.capture.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const transport = new Transport('ws://127.0.0.1:4311')
      transport.connect()
      const socket = Socket.last
      socket.open()
      const requestId = '0dca4330-66f5-4f68-9287-c6b2bf4c6bf0'
      const request = {
        requestId,
        url: 'http://127.0.0.1:5183/',
        viewports: [{ width: 800, height: 600 }],
      }
      socket.onmessage?.({
        data: JSON.stringify({ channel: 'preview.captureRequested', sequence: 1, data: request }),
      })
      await vi.waitFor(() => expect(native.capture).toHaveBeenCalledWith(request))
      if (action === 'disconnect') transport.close()
      else
        socket.onmessage?.({
          data: JSON.stringify({
            channel: 'preview.captureCancelled',
            sequence: 2,
            data: { requestId },
          }),
        })
      await vi.waitFor(() => expect(native.cancel).toHaveBeenCalledWith(requestId))
      finish({ status: 'failed', requestId, error: 'Stopped' })
      await Promise.resolve()
      expect(socket.sent.some((frame) => frame.includes('preview.captureResult'))).toBe(false)
      transport.close()
    },
  )
})
