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

describe('clipboard bridge', () => {
  it('delegates text writes to the native bridge', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as { harness?: unknown }).harness = { isDesktop: true, writeClipboardText }
    const bridge = await import('./bridge.js')

    await expect(bridge.writeClipboardText('copied text')).resolves.toBe(undefined)
    expect(writeClipboardText).toHaveBeenCalledWith('copied text')
  })
})

describe('haptic bridge', () => {
  it('sends only the named native feedback pattern', async () => {
    const prepareHaptics = vi.fn()
    const performHaptic = vi.fn()
    ;(globalThis as { harness?: unknown }).harness = {
      isDesktop: true,
      prepareHaptics,
      performHaptic,
    }
    const bridge = await import('./bridge.js')

    bridge.prepareNativeHaptics()
    bridge.performNativeHaptic('alignment')

    expect(prepareHaptics).toHaveBeenCalledOnce()
    expect(performHaptic).toHaveBeenCalledWith('alignment')
  })
})

describe('external URL bridge', () => {
  it('delegates system-browser links to the desktop shell', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as { harness?: unknown }).harness = { isDesktop: true, openExternal }
    const bridge = await import('./bridge.js')

    await expect(bridge.openExternalUrl('https://example.com/')).resolves.toBeUndefined()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })
})
