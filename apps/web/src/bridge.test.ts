import { afterEach, describe, expect, it, vi } from 'vitest'

const request = {
  requestId: '0dca4330-66f5-4f68-9287-c6b2bf4c6bf0',
  url: 'http://127.0.0.1:5183/',
  viewports: [{ width: 1_440, height: 900 }],
}

afterEach(() => {
  delete (globalThis as { harness?: unknown }).harness
  vi.resetModules()
})

describe('preview capture bridge', () => {
  it('degrades when no native bridge exists', async () => {
    const bridge = await import('./bridge.js')

    expect(bridge.canCapturePreview).toBe(false)
    await expect(bridge.capturePreview(request)).resolves.toMatchObject({ status: 'failed' })
  })

  it('delegates to the native bridge', async () => {
    const result = { status: 'completed' as const, requestId: request.requestId, screenshots: [] }
    const capturePreview = vi.fn().mockResolvedValue(result)
    ;(globalThis as { harness?: unknown }).harness = { isDesktop: true, capturePreview }
    const bridge = await import('./bridge.js')

    expect(bridge.canCapturePreview).toBe(true)
    await expect(bridge.capturePreview(request)).resolves.toEqual(result)
    expect(capturePreview).toHaveBeenCalledWith(request)
  })
})
