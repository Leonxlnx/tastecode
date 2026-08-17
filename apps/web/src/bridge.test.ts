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

describe('attachment preview bridge', () => {
  it('reuses the signed preview returned by the file picker', async () => {
    const picked = {
      path: '/work/reference.png',
      name: 'reference.png',
      mediaType: 'image' as const,
      previewUrl: 'tastecode-attachment://preview/reference',
    }
    const pickFiles = vi.fn().mockResolvedValue([picked])
    const previewViewedImage = vi.fn()
    ;(globalThis as { harness?: unknown }).harness = {
      isDesktop: true,
      pickFiles,
      previewViewedImage,
    }
    const bridge = await import('./bridge.js')

    await expect(bridge.pickFiles()).resolves.toEqual([picked])
    await expect(bridge.previewViewedImage(picked.path)).resolves.toEqual(picked)
    expect(previewViewedImage).not.toHaveBeenCalled()
  })

  it('resolves a persisted pasted-file path through its safe basename', async () => {
    const preview = {
      path: '/private/tmp/TasteCode/pasted-files/uuid-reference.png',
      name: 'uuid-reference.png',
      mediaType: 'image' as const,
      previewUrl: 'tastecode-attachment://preview/pasted',
    }
    const previewViewedImage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(preview)
    ;(globalThis as { harness?: unknown }).harness = { isDesktop: true, previewViewedImage }
    const bridge = await import('./bridge.js')

    await expect(bridge.previewViewedImage(preview.path)).resolves.toEqual(preview)
    expect(previewViewedImage).toHaveBeenNthCalledWith(1, preview.path)
    expect(previewViewedImage).toHaveBeenNthCalledWith(2, preview.name)
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

describe('local diagnostics bridge', () => {
  it('is off and inert in the browser', async () => {
    const bridge = await import('./bridge.js')

    await expect(bridge.localDiagnosticsEnabled()).resolves.toBe(false)
    await expect(bridge.setLocalDiagnosticsEnabled(true)).resolves.toBe(false)
    expect(() => bridge.reportRendererError(new Error('test'))).not.toThrow()
  })

  it('delegates the preference and redacted error source to the desktop', async () => {
    const setDiagnosticsEnabled = vi.fn().mockResolvedValue(true)
    const reportRendererError = vi.fn()
    ;(globalThis as { harness?: unknown }).harness = {
      isDesktop: true,
      setDiagnosticsEnabled,
      reportRendererError,
    }
    const bridge = await import('./bridge.js')

    await expect(bridge.setLocalDiagnosticsEnabled(true)).resolves.toBe(true)
    bridge.reportRendererError(new Error('renderer failed'))
    expect(setDiagnosticsEnabled).toHaveBeenCalledWith(true)
    expect(reportRendererError).toHaveBeenCalledWith(expect.stringContaining('renderer failed'))
  })
})

describe('app update bridge', () => {
  it('stays unsupported in the browser', async () => {
    const bridge = await import('./bridge.js')

    await expect(bridge.appUpdateState()).resolves.toEqual({
      status: 'unsupported',
      currentVersion: 'pre-release',
    })
    await expect(bridge.installAppUpdate()).resolves.toBe(false)
  })

  it('delegates update checks and state events to the desktop shell', async () => {
    const state = { status: 'ready' as const, currentVersion: '1.0.0', version: '1.0.1' }
    const checkForUpdates = vi.fn().mockResolvedValue(state)
    const onUpdateState = vi.fn((listener: (next: typeof state) => void) => {
      listener(state)
      return () => undefined
    })
    ;(globalThis as { harness?: unknown }).harness = {
      isDesktop: true,
      checkForUpdates,
      onUpdateState,
    }
    const bridge = await import('./bridge.js')
    const listener = vi.fn()

    await expect(bridge.checkForAppUpdates()).resolves.toEqual(state)
    bridge.onAppUpdateState(listener)
    expect(checkForUpdates).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(state)
  })
})
