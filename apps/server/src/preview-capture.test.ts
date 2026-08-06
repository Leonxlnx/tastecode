import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { PreviewCaptureCoordinator } from './preview-capture.js'

const socket = {} as WebSocket
const viewports = [{ width: 1_440, height: 900 }]

describe('preview capture coordinator', () => {
  it('round-trips a capture through a capable client', async () => {
    const send = vi.fn()
    const coordinator = new PreviewCaptureCoordinator(send)
    coordinator.setCapability(socket, true)
    const capture = coordinator.capture('http://127.0.0.1:5183/', viewports)
    const request = send.mock.calls[0]![1]
    coordinator.complete(socket, {
      status: 'completed',
      requestId: request.requestId,
      screenshots: [{ path: 'C:\\tmp\\desktop.png', ...viewports[0]! }],
    })

    await expect(capture).resolves.toEqual([{ path: 'C:\\tmp\\desktop.png', ...viewports[0]! }])
  })

  it('fails fast without a capable client', async () => {
    const coordinator = new PreviewCaptureCoordinator(vi.fn())
    await expect(coordinator.capture('http://127.0.0.1:5183/', viewports)).rejects.toThrow(
      'unavailable',
    )
  })
})
