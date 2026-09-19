import { describe, expect, it, vi } from 'vitest'
import { PreviewCaptureCoordinator } from './preview-capture.js'

const socket = {}
const viewports = [{ width: 1_440, height: 900 }]

describe('preview capture coordinator', () => {
  it('cancels timed-out desktop work before sending the next queued capture', async () => {
    vi.useFakeTimers()
    try {
      const operations: string[] = []
      const coordinator = new PreviewCaptureCoordinator<object>(
        () => operations.push('send'),
        10,
        () => operations.push('cancel'),
      )
      coordinator.setCapability(socket, true)
      const first = coordinator.capture('http://127.0.0.1:5101/', viewports)
      const firstFailure = expect(first).rejects.toThrow(/timed out/)
      const next = coordinator.capture('http://127.0.0.1:5102/', viewports)
      const nextFailure = expect(next).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(10)
      await firstFailure
      expect(operations).toEqual(['send', 'cancel', 'send'])
      coordinator.remove(socket)
      await vi.advanceTimersByTimeAsync(10)
      await nextFailure
      expect(operations.at(-1)).toBe('cancel')
    } finally {
      vi.useRealTimers()
    }
  })
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

  it.each(['disconnect', 'send failure'])(
    'retries a capture after %s without restarting its deadline or blocking the queue',
    async (failure) => {
      vi.useFakeTimers()
      try {
        const send = vi.fn()
        if (failure === 'send failure')
          send.mockImplementationOnce(() => {
            throw new Error('closed')
          })
        const cancel = vi.fn()
        const coordinator = new PreviewCaptureCoordinator<object>(send, 100, cancel)
        coordinator.setCapability(socket, true)
        const first = coordinator.capture('http://127.0.0.1:5101/', viewports)
        const firstFailure = expect(first).rejects.toThrow('Preview capture timed out')
        const original = send.mock.calls[0]![1]
        if (failure === 'disconnect') coordinator.remove(socket)
        expect(cancel).toHaveBeenCalledWith(socket, original.requestId)
        await vi.advanceTimersByTimeAsync(70)
        const replacement = {}
        coordinator.setCapability(replacement, true)
        const retry = send.mock.calls[1]![1]
        expect(retry.requestId).not.toBe(original.requestId)
        expect(retry.url).toBe(original.url)
        expect(() =>
          coordinator.complete(socket, {
            status: 'failed',
            requestId: original.requestId,
            error: 'old capture',
          }),
        ).toThrow('Unknown preview capture request')
        const next = coordinator.capture('http://127.0.0.1:5102/', viewports)
        await vi.advanceTimersByTimeAsync(30)
        await firstFailure
        expect(cancel).toHaveBeenCalledWith(replacement, retry.requestId)
        const last = send.mock.calls[2]![1]
        coordinator.complete(replacement, {
          status: 'completed',
          requestId: last.requestId,
          screenshots: [{ path: 'C:\\tmp\\next.png', ...viewports[0]! }],
        })
        await expect(next).resolves.toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('finishes the same capture on a replacement client', async () => {
    const send = vi.fn()
    const coordinator = new PreviewCaptureCoordinator<object>(send)
    coordinator.setCapability(socket, true)
    const capture = coordinator.capture('http://127.0.0.1:5101/', viewports)
    coordinator.remove(socket)
    const replacement = {}
    coordinator.setCapability(replacement, true)
    coordinator.complete(replacement, {
      status: 'completed',
      requestId: send.mock.calls[1]![1].requestId,
      screenshots: [{ path: 'C:\\tmp\\recovered.png', ...viewports[0]! }],
    })
    await expect(capture).resolves.toMatchObject([{ path: 'C:\\tmp\\recovered.png' }])
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
