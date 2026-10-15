import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { REFERENCE_REVEAL_SOURCE } from './motion-guidance.js'

it('re-arms unplayed reveals after a Strict Mode setup-cleanup-setup cycle', () => {
  const observers: Array<{
    enter: (entries: unknown[]) => void
    observe: ReturnType<typeof vi.fn>
    unobserve: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }> = []
  const element = {
    dataset: {} as Record<string, string>,
    getBoundingClientRect: () => ({ top: 2000, bottom: 2300 }),
    animate: vi.fn(() => ({
      pause: vi.fn(),
      play: vi.fn(),
      cancel: vi.fn(),
      onfinish: undefined as undefined | null | (() => void),
    })),
  }
  const root = { querySelectorAll: () => [element] }
  const install = runInNewContext(
    REFERENCE_REVEAL_SOURCE.replace('export function', 'function') + '\ninstallReferenceReveals',
    {
      document: { visibilityState: 'visible' },
      innerHeight: 800,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      IntersectionObserver: function (enter: (entries: unknown[]) => void) {
        const observer = { enter, observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
        observers.push(observer)
        return observer
      },
    },
  )
  const cleanup = install(root)
  cleanup()
  expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
  expect(element.animate.mock.results[0]!.value.cancel).toHaveBeenCalledOnce()
  expect(element.dataset.revealPlayed).toBeUndefined()
  const cleanupAgain = install(root)
  observers[0]!.enter([
    { target: element, isIntersecting: true, boundingClientRect: { bottom: 300 } },
  ])
  expect(element.dataset.revealPlayed).toBeUndefined()
  expect(element.animate).toHaveBeenCalledTimes(2)
  expect(observers[1]!.observe).toHaveBeenCalledWith(element)
  observers[1]!.enter([
    { target: element, isIntersecting: true, boundingClientRect: { bottom: 300 } },
  ])
  expect(element.animate.mock.results[1]!.value.play).toHaveBeenCalledOnce()
  expect(element.dataset.revealPlayed).toBe('true')
  cleanupAgain()
  install(root)()
  expect(element.animate).toHaveBeenCalledTimes(2)
})
