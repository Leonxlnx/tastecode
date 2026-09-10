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
    expect(scrollTo).toHaveBeenLastCalledWith(0, 120)
  })

  it('bounds whole-page captures to a safe bitmap height', () => {
    expect(
      vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
        document: { body: { scrollHeight: 20_000 }, documentElement: { scrollHeight: 20_000 } },
        innerHeight: 844,
        Math,
      }),
    ).toBe(12_000)
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
    expect(scrollTo).toHaveBeenLastCalledWith(0, 140)
    expect(listeners.size).toBe(0)
    expect(callbacks.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clamps a hostile page result again in trusted main-process code', () => {
    const value = vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
      document: { body: { scrollHeight: 800 }, documentElement: { scrollHeight: 800 } },
      innerHeight: 844,
      Math: { min: () => 100_000_000, max: Math.max },
    })
    expect(value).toBe(100_000_000)
    expect(previewCaptureHeight(value, 844)).toBe(12_000)
    expect(previewCaptureHeight(Number.MAX_VALUE, 844)).toBe(12_000)
    expect(previewCaptureHeight(900.25, 844)).toBe(901)
    expect(previewCaptureHeight(1, 844)).toBe(844)
  })

  it.each([NaN, Infinity, -Infinity, 0, -1, '1200', null, {}, undefined])(
    'rejects an invalid measurement before native capture: %s',
    (value) =>
      expect(() => previewCaptureHeight(value, 844)).toThrow('Invalid preview page height'),
  )
})
