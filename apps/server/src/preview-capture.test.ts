import { describe, expect, it, vi } from 'vitest'
import { PreviewCaptureCoordinator } from './preview-capture.js'

const socket = {}
const viewports = [{ width: 1_440, height: 900 }]

describe('preview capture coordinator', () => {
  it('round-trips a capture through a capable client', async () => {
    const send = vi.fn()
    const coordinator = new PreviewCaptureCoordinator<object>(send)
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
    expect(coordinator.available).toBe(false)
    await expect(coordinator.capture('http://127.0.0.1:5183/', viewports)).rejects.toThrow(
      'unavailable',
    )
  })

  it('serializes captures that share the desktop capture session', async () => {
    const send = vi.fn()
    const coordinator = new PreviewCaptureCoordinator(send)
    coordinator.setCapability(socket, true)

    const first = coordinator.capture('http://127.0.0.1:5183/', viewports)
    const second = coordinator.capture('http://127.0.0.1:5184/', viewports)
    expect(send).toHaveBeenCalledTimes(1)

    const firstRequest = send.mock.calls[0]![1]
    coordinator.complete(socket, {
      status: 'completed',
      requestId: firstRequest.requestId,
      screenshots: [{ path: 'C:\\tmp\\first.png', ...viewports[0]! }],
    })
    await expect(first).resolves.toMatchObject([{ path: 'C:\\tmp\\first.png' }])
    expect(send).toHaveBeenCalledTimes(2)

    const secondRequest = send.mock.calls[1]![1]
    coordinator.complete(socket, {
      status: 'completed',
      requestId: secondRequest.requestId,
      screenshots: [{ path: 'C:\\tmp\\second.png', ...viewports[0]! }],
    })
    await expect(second).resolves.toMatchObject([{ path: 'C:\\tmp\\second.png' }])
  })
})
