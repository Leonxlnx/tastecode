// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'

const VIEWPORT = 800
const ROW = 50
const TURNS = 150

/** Every row element the page ever rendered, by its index. */
let rendered: Set<number>
/** The height each row measures, by its index. */
let rowHeight: (index: number) => number
/** Animation frames asked for and not yet run. */
let frames: FrameRequestCallback[]
const scrollTops = new WeakMap<Element, number>()

beforeEach(() => {
  rendered = new Set()
  rowHeight = () => ROW
  frames = []
  const heightOf = (element: HTMLElement) => {
    if (element.classList.contains('thread')) return VIEWPORT
    const index = element.getAttribute('data-index')
    return index === null ? 0 : rowHeight(Number(index))
  }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  // The scroller is as tall as its runway, and a scroll position stays where it was put.
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    const runway = this.querySelector<HTMLElement>('.thread__runway')
    return runway ? Number.parseFloat(runway.style.height) || 0 : 0
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return scrollTops.get(this) ?? 0
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    top: number,
  ) {
    scrollTops.set(this, top)
  })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  // The list observes each row it mounts; record them all, whatever happens to them later.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(target: Element) {
        const index = target.getAttribute('data-index')
        if (index !== null) rendered.add(Number(index))
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Run the frames asked for so far, and those they ask for, a few rounds deep. */
function runFrames() {
  for (let round = 0; round < 5 && frames.length > 0; round += 1) {
    const due = frames
    frames = []
    act(() => {
      for (const frame of due) frame(performance.now())
    })
  }
}

function heldTranscript(turns = TURNS): Item[] {
  const items: Item[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    const base = { turnId: `turn-${turn}`, type: 'message', status: 'completed' } as const
    items.push({
      ...base,
      id: `prompt-${turn}`,
      role: 'user',
      text: `Question ${turn}`,
      createdAt: turn * 2,
    })
    items.push({
      ...base,
      id: `answer-${turn}`,
      role: 'assistant',
      text: `Answer ${turn}`,
      createdAt: turn * 2 + 1,
    })
  }
  return items
}

function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('.thread')
  if (!scroller) throw new Error('no scroller')
  return scroller
}

/** Where the list put a row: it writes the offset straight to the row's style. */
function rowTop(row: HTMLElement): number {
  const moved = /translate(?:3d\(0,\s*|Y\()(-?[\d.]+)px/.exec(row.style.transform)
  if (moved) return Number(moved[1])
  return Number.parseFloat(row.style.top) || 0
}

describe('Thread opened with a transcript the renderer holds', () => {
  it('renders the rows at its end, never the first screen it scrolls away from', () => {
    const items = heldTranscript()
    const store = new ThreadFrameStore({ ...emptyThread, items })
    const view = render(
      <Thread
        frameStore={store}
        threadId="held"
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    // The last exchange is on screen.
    expect(rendered.has(items.length - 1)).toBe(true)
    expect(view.container.textContent).toContain(`Answer ${TURNS - 1}`)
    // Nothing from the top of the chat was ever drawn on the way there.
    expect(rendered.has(0)).toBe(false)
    expect(Math.min(...rendered)).toBeGreaterThan(items.length - 60)
  })

  it('starts an empty chat at its top and still lands at the end once its rows arrive', () => {
    // Several viewports of uneven rows: the end is only on screen if the open scrolled there.
    rowHeight = (index) => (index % 3 === 0 ? 140 : 60)
    const items = heldTranscript(20)
    const total = items.reduce((sum, _, index) => sum + rowHeight(index), 0)
    expect(total).toBeGreaterThan(VIEWPORT * 3)
    const store = new ThreadFrameStore(emptyThread)
    const view = render(
      <Thread
        frameStore={store}
        threadId="cold"
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const scroller = scrollerOf(view.container)
    expect(scroller.scrollTop).toBe(0)

    act(() => store.publish({ ...emptyThread, items }))
    runFrames()
    act(() => {
      fireEvent.scroll(scroller)
    })
    runFrames()

    const last = view.container.querySelector<HTMLElement>(
      `.thread__row[data-index="${items.length - 1}"]`,
    )
    expect(last).not.toBeNull()
    expect(last!.textContent).toContain('Answer 19')
    const top = rowTop(last!)
    // The last answer is inside the viewport where the open settled.
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(top).toBeLessThan(scroller.scrollTop + VIEWPORT)
    expect(top + rowHeight(items.length - 1)).toBeGreaterThan(scroller.scrollTop)
  })
})
