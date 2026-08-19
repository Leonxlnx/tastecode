import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  boundedPreviewPageHeight,
  PREVIEW_PAGE_HEIGHT_SCRIPT,
  PREVIEW_SETTLE_SCRIPT,
} from './preview-settle.js'

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
            addEventListener: (name: string, listener: () => void) => {
              pendingListeners.set(name, listener)
            },
          },
        ],
      },
      requestAnimationFrame: frame,
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

  it('measures page height without consulting page-owned Math', () => {
    const hostileMath = new Proxy(
      {},
      {
        get: () => {
          throw new Error('page-owned Math must not be used')
        },
      },
    )
    const measurement = vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
      document: { body: { scrollHeight: 1_600 }, documentElement: { scrollHeight: 1_800 } },
      Math: hostileMath,
    }) as unknown

    expect(boundedPreviewPageHeight(measurement, 844)).toBe(1_800)
  })

  it('clamps a valid oversize page before bitmap allocation', () => {
    expect(boundedPreviewPageHeight({ body: 18_000, documentElement: 20_000 }, 844)).toBe(12_000)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite page height',
    (height) => {
      expect(() => boundedPreviewPageHeight({ body: 0, documentElement: height }, 844)).toThrow(
        'preview returned an invalid page height',
      )
    },
  )

  it.each([-1, -10_000])('rejects a negative page height', (height) => {
    expect(() => boundedPreviewPageHeight({ body: height, documentElement: 0 }, 844)).toThrow(
      'preview returned an invalid page height',
    )
  })

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a page height that is not a safe integer',
    (height) => {
      expect(() => boundedPreviewPageHeight({ body: 0, documentElement: height }, 844)).toThrow(
        'preview returned an invalid page height',
      )
    },
  )

  it('uses the trusted viewport as the minimum capture height', () => {
    expect(boundedPreviewPageHeight({ body: 0, documentElement: 120 }, 844)).toBe(844)
  })
})
