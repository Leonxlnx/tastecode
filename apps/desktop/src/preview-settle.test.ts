import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PREVIEW_PAGE_HEIGHT_SCRIPT, PREVIEW_SETTLE_SCRIPT } from './preview-settle.js'

describe('preview capture settling', () => {
  it('waits for decoded and pending images before the final paint frames', async () => {
    const decode = vi.fn(async () => undefined)
    const pendingListeners = new Map<string, () => void>()
    const frame = vi.fn((resolve: () => void) => resolve())
    const scrollTo = vi.fn()

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

  it('bounds whole-page captures to a safe bitmap height', () => {
    expect(
      vm.runInNewContext(PREVIEW_PAGE_HEIGHT_SCRIPT, {
        document: { body: { scrollHeight: 20_000 }, documentElement: { scrollHeight: 20_000 } },
        innerHeight: 844,
        Math,
      }),
    ).toBe(12_000)
  })
})
