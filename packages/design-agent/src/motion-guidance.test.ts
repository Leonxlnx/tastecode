import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { REFERENCE_REVEAL_SOURCE } from './motion-guidance.js'

describe('reference reveal lifecycle', () => {
  it('never hides painted content, replays, or leaves hidden content after cleanup/reduced motion', () => {
    let enter: (entries: unknown[]) => void
    let preference: () => void
    const reduced = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => {
        preference = fn
      },
      removeEventListener: vi.fn(),
    }
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
    const makeElement = (top: number) => ({
      dataset: {} as Record<string, string>,
      getBoundingClientRect: () => ({ top, bottom: top + 1600 }),
      animate: vi.fn(() => ({
        pause: vi.fn(),
        play: vi.fn(),
        cancel: vi.fn(),
        onfinish: undefined as undefined | (() => void),
      })),
    })
    const visible = makeElement(200)
    const below = makeElement(1200)
    const later = makeElement(3000)
    const root = { querySelectorAll: () => [visible, below, later] }
    const install = runInNewContext(
      REFERENCE_REVEAL_SOURCE.replace('export function', 'function') + '\ninstallReferenceReveals',
      {
        document: { visibilityState: 'visible' },
        innerHeight: 800,
        matchMedia: () => reduced,
        IntersectionObserver: function (callback: typeof enter, options: unknown) {
          enter = callback
          expect(options).toEqual({ threshold: 0, rootMargin: '0px 0px 96px 0px' })
          return observer
        },
      },
    )
    const cleanup = install(root)
    expect(visible.animate).not.toHaveBeenCalled()
    const animation = below.animate.mock.results[0]!.value
    expect(animation.pause).toHaveBeenCalledOnce()
    enter!([{ target: below, isIntersecting: true, boundingClientRect: { bottom: 1800 } }])
    expect(observer.unobserve).toHaveBeenCalledWith(below)
    expect(animation.play).toHaveBeenCalledOnce()
    animation.onfinish!()
    expect(animation.cancel).toHaveBeenCalledOnce()
    reduced.matches = true
    preference!()
    expect(later.animate.mock.results[0]!.value.cancel).toHaveBeenCalledOnce()
    cleanup()
    reduced.matches = false
    install(root)()
    expect(below.animate).toHaveBeenCalledOnce()
    expect(later.animate).toHaveBeenCalledOnce()
    expect(reduced.removeEventListener).toHaveBeenCalled()
  })
})
