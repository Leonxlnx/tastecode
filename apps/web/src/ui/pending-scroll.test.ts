// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import { shiftPendingScrollIndex } from './pending-scroll.js'

const ROW = 100

/** The real virtual-core, so a renamed private field fails here rather than in a jump. */
function virtualizer(count: number) {
  const scrolls: number[] = []
  const element = document.createElement('div')
  // Virtual-core clamps a jump to what the element can scroll.
  Object.defineProperty(element, 'clientHeight', { value: 2 * ROW })
  Object.defineProperty(element, 'scrollHeight', { get: () => instance.options.count * ROW })
  const instance = new Virtualizer<HTMLDivElement, Element>({
    count,
    getScrollElement: () => element,
    estimateSize: () => ROW,
    scrollToFn: (offset) => scrolls.push(offset),
    observeElementRect: (_, notify) => {
      notify({ width: 400, height: 2 * ROW })
      return () => undefined
    },
    observeElementOffset: (_, notify) => {
      notify(0, false)
      return () => undefined
    },
  })
  const cleanup = instance._didMount()
  instance._willUpdate()
  // Mounting restores the initial offset; only later scrolls matter here.
  scrolls.length = 0
  return { instance, scrolls, cleanup }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('shiftPendingScrollIndex', () => {
  it('moves an in-flight scrollToIndex by the rows prepended above it', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] })
    const { instance, scrolls, cleanup } = virtualizer(20)
    instance.scrollToIndex(5, { align: 'start' })
    expect(scrolls).toEqual([5 * ROW])

    instance.setOptions({ ...instance.options, count: 23 })
    shiftPendingScrollIndex(instance, 3)
    // The next frame re-aims the settling jump at the same row, now 3 lower.
    vi.advanceTimersToNextFrame()
    expect(scrolls.at(-1)).toBe(8 * ROW)
    cleanup()
  })

  it('leaves the virtualizer alone when no jump is settling', () => {
    const { instance, scrolls, cleanup } = virtualizer(20)
    expect(() => shiftPendingScrollIndex(instance, 3)).not.toThrow()
    expect(scrolls).toEqual([])
    cleanup()
  })
})
