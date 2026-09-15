import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PREVIEW_PAGE_HEIGHT_SCRIPT,
  PREVIEW_SETTLE_SCRIPT,
  previewCaptureHeight,
} from './preview-settle.js'

afterEach(() => vi.useRealTimers())

describe('preview capture settling', () => {
  it('waits for decoded and pending images before the final paint frames', async () => {
    const decode = vi.fn(async () => undefined)
    const pendingListeners = new Map<string, () => void>()
    const frame = vi.fn((resolve: () => void) => resolve())
    const scrollTo = vi.fn()

    // SAFETY: PREVIEW_SETTLE_SCRIPT ends with an async IIFE and returns Promise<void>.
    const settled = vm.runInNewContext(PREVIEW_SETTLE_SCRIPT, {
      Array,
      Promise,
      document: {
        body: { scrollHeight: 1800 },
        documentElement: { scrollHeight: 1800 },
        fonts: { ready: Promise.resolve() },
        getAnimations: () => [],
        images: [
          { complete: true, decode },
          {
            complete: false,
            removeEventListener: vi.fn(),
            addEventListener: (name: string, listener: () => void) => {
              pendingListeners.set(name, listener)
            },
          },
        ],
      },
      requestAnimationFrame: frame,
      cancelAnimationFrame: vi.fn(),
      clearTimeout,
      innerHeight: 844,
      scrollTo,
      scrollX: 0,
      scrollY: 120,
      setTimeout,
    }) as Promise<void>

    await vi.waitFor(() => expect(pendingListeners.get('load')).toBeDefined())
    pendingListeners.get('load')?.()
    await settled

    expect(decode).toHaveBeenCalledOnce()
    expect(frame).toHaveBeenCalledTimes(6)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 120, behavior: 'instant' })
  })

  it('bounds whole-page captures to a safe bitmap height', () => {
    expect(
      vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
        document: { body: { scrollHeight: 20_000 }, documentElement: { scrollHeight: 20_000 } },
        innerHeight: 844,
        Math,
      }),
    ).toEqual({ body: 20_000, documentElement: 20_000 })
  })

  it('finishes with suspended frames, fonts, and images and releases every wait', async () => {
    vi.useFakeTimers()
    const callbacks = new Map<number, () => void>()
    let nextFrame = 0
    const listeners = new Map<string, () => void>()
    const scrollTo = vi.fn()
    const never = new Promise(() => {})
    const result = vm.runInNewContext(PREVIEW_SETTLE_SCRIPT, {
      document: {
        documentElement: { scrollHeight: 800 },
        body: { scrollHeight: 800 },
        fonts: { ready: never },
        getAnimations: () => [{ finished: never }],
        images: [
          {
            complete: false,
            addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name),
          },
        ],
      },
      requestAnimationFrame: (callback: () => void) => {
        callbacks.set(++nextFrame, callback)
        return nextFrame
      },
      cancelAnimationFrame: (id: number) => callbacks.delete(id),
      setTimeout,
      clearTimeout,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 140,
      scrollTo,
    }) as Promise<void>
    await vi.advanceTimersByTimeAsync(3000)
    await result
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 140, behavior: 'instant' })
    expect(listeners.size).toBe(0)
    expect(callbacks.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores hostile page Math and bounds valid raw measurements', () => {
    const value = vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
      document: { body: { scrollHeight: 800 }, documentElement: { scrollHeight: 800 } },
      Math: new Proxy(
        {},
        {
          get: () => {
            throw new Error('Untrusted Math')
          },
        },
      ),
    })
    expect(previewCaptureHeight(value, 844)).toBe(844)
    expect(previewCaptureHeight({ body: 100_000_000, documentElement: 100_000_000 }, 844)).toBe(
      12_000,
    )
    expect(previewCaptureHeight({ body: 0, documentElement: 1800 }, 844)).toBe(1800)
  })

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '1200',
    null,
    undefined,
  ])('rejects invalid DOM and viewport measurements: %s', (value) => {
    expect(() => previewCaptureHeight({ body: value, documentElement: 0 }, 844)).toThrow(
      'Invalid preview page height',
    )
    expect(() => previewCaptureHeight({ body: 0, documentElement: value }, 844)).toThrow(
      'Invalid preview page height',
    )
    expect(() => previewCaptureHeight({ body: 0, documentElement: 0 }, value as number)).toThrow(
      'Invalid preview page height',
    )
  })

  it.each([null, undefined, 1000, {}, { body: 0 }, { documentElement: 0 }])(
    'rejects malformed measurement objects: %s',
    (value) => {
      expect(() => previewCaptureHeight(value, 844)).toThrow('Invalid preview page height')
    },
  )

  it('accepts an empty document but rejects a zero viewport', () => {
    expect(previewCaptureHeight({ body: 0, documentElement: 0 }, 844)).toBe(844)
    expect(() => previewCaptureHeight({ body: 0, documentElement: 0 }, 0)).toThrow(
      'Invalid preview page height',
    )
  })
})
