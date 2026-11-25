// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadMonospaceFont } from './font-preload.js'

type IdleWindow = {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

function stubIdle() {
  const callbacks: IdleRequestCallback[] = []
  Object.assign(window as IdleWindow, {
    requestIdleCallback: vi.fn((callback: IdleRequestCallback) => callbacks.push(callback)),
    cancelIdleCallback: vi.fn(),
  })
  return () => {
    for (const callback of callbacks.splice(0))
      callback({ didTimeout: false, timeRemaining: () => 10 })
  }
}

function stubFonts(load: (font: string, text?: string) => Promise<FontFace[]>) {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load } })
}

const MONO = `'Geist Mono Variable', 'Cascadia Code', ui-monospace, monospace`

afterEach(() => {
  delete (window as IdleWindow).requestIdleCallback
  delete (window as IdleWindow).cancelIdleCallback
  Reflect.deleteProperty(document, 'fonts')
  document.documentElement.style.removeProperty('--font-mono')
})

describe('preloadMonospaceFont', () => {
  it('loads the monospace face in an idle moment, before a transcript lays any out', () => {
    const runIdle = stubIdle()
    const load = vi.fn(() => Promise.resolve([] as FontFace[]))
    stubFonts(load)
    document.documentElement.style.setProperty('--font-mono', MONO)

    preloadMonospaceFont()
    expect(load).not.toHaveBeenCalled()
    runIdle()

    // The whole stack, as the transcript names it: only its web fonts load,
    // and only the faces covering Latin text (the default text is a space).
    expect(load).toHaveBeenCalledExactlyOnceWith(`1em ${MONO}`)
  })

  it('drops a failed load; the font then loads on first use as before', async () => {
    const runIdle = stubIdle()
    const load = vi.fn(() => Promise.reject(new Error('font missing')))
    stubFonts(load)
    document.documentElement.style.setProperty('--font-mono', MONO)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      preloadMonospaceFont()
      runIdle()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(load).toHaveBeenCalledOnce()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('loads nothing without a font set or a monospace font', () => {
    const runIdle = stubIdle()
    preloadMonospaceFont()
    expect(() => runIdle()).not.toThrow()

    const load = vi.fn(() => Promise.resolve([] as FontFace[]))
    stubFonts(load)
    preloadMonospaceFont()
    runIdle()
    expect(load).not.toHaveBeenCalled()
  })

  it('can be cancelled before the idle moment comes', () => {
    stubIdle()
    const load = vi.fn(() => Promise.resolve([] as FontFace[]))
    stubFonts(load)
    document.documentElement.style.setProperty('--font-mono', MONO)

    preloadMonospaceFont()()
    expect(window.cancelIdleCallback).toHaveBeenCalledOnce()
    expect(load).not.toHaveBeenCalled()
  })
})
