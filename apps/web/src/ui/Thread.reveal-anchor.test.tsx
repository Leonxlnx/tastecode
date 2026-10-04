// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'

const VIEWPORT = 200
const ROW = 100
const OPEN_ROW = 300

const layout = vi.hoisted(() => ({
  count: 0,
  sizes: [] as { size: number }[],
  /** The runway height the last render committed; the scroll height follows it. */
  committed: 0,
  /** Scrollable overflow a sliding runway adds below the committed height. */
  overflow: 0,
  /** Overflow a closing reveal adds while it still hangs below its summary. */
  closingOverflow: 0,
  /** Correct the scroll on resize, as the virtualizer does for rows it thinks are above the fold. */
  correctScroll: false,
  openRow: 0,
  summaryTop: 0,
  scrollTop: 0,
  rerender: () => undefined as void,
}))

/** The scroll end once every slide has settled. */
const maxScrollTop = () => Math.max(0, layout.committed - VIEWPORT)
/** What the browser reports mid-slide: transformed boxes extend the scrollable overflow. */
const scrollHeight = () =>
  layout.committed +
  layout.overflow +
  (document.querySelector("[data-open='closing']") ? layout.closingOverflow : 0)
const clampScrollTop = (top: number) => Math.max(0, Math.min(top, scrollHeight() - VIEWPORT))

vi.mock('@tanstack/react-virtual', async () => {
  const { useReducer } = await import('react')
  const total = () => layout.sizes.reduce((sum, row) => sum + row.size, 1_000)
  const virtualizer = {
    getVirtualItems: () =>
      Array.from({ length: layout.count }, (_, index) => ({
        index,
        key: index,
        start: index * ROW,
      })),
    getTotalSize: total,
    measureElement: () => undefined,
    get measurementsCache() {
      return layout.sizes
    },
    indexFromElement: (element: Element) => Number(element.getAttribute('data-index')),
    // Like the real virtualizer: the new size reaches the DOM on the next render.
    resizeItem: (index: number, size: number) => {
      const delta = size - (layout.sizes[index]?.size ?? size)
      layout.sizes[index] = { size }
      // The runway has not grown yet, so the browser clamps this write.
      if (layout.correctScroll) layout.scrollTop = clampScrollTop(layout.scrollTop + delta)
      layout.rerender()
    },
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }
  return {
    useVirtualizer: ({ count }: { count: number }) => {
      const [, rerender] = useReducer((version: number) => version + 1, 0)
      layout.rerender = rerender
      if (layout.sizes.length !== count) {
        layout.sizes = Array.from(
          { length: count },
          (_, index) => layout.sizes[index] ?? { size: ROW },
        )
      }
      layout.count = count
      layout.committed = total()
      return virtualizer
    },
  }
})

function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

beforeEach(() => {
  layout.sizes = []
  layout.scrollTop = 0
  layout.overflow = 0
  layout.closingOverflow = 0
  layout.correctScroll = false
  layout.openRow = OPEN_ROW
  layout.summaryTop = 50
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(scrollHeight)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
  // The browser clamps the scroll position to the committed scroll height.
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(() =>
    clampScrollTop(layout.scrollTop),
  )
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation((top: number) => {
    layout.scrollTop = top
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('thread')) return rect(0, VIEWPORT)
    // The column's layout box: in-flow height only, no animated overflow.
    if (this.classList.contains('thread__col')) return rect(0, layout.committed)
    if (this.classList.contains('thread__row')) {
      const open = this.querySelector(":scope [data-open='opening'], :scope [data-open='true']")
      return rect(0, open ? layout.openRow : ROW)
    }
    return rect(layout.summaryTop, 30)
  })
  Element.prototype.getAnimations = () => []
  Element.prototype.animate = (() => ({ cancel: () => undefined })) as unknown as Element['animate']
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function item(id: string, createdAt: number, fields: Partial<Item>): Item {
  return {
    id,
    turnId: 'turn',
    type: 'message',
    status: 'completed',
    createdAt,
    ...fields,
  } as Item
}

describe('disclosure scroll anchoring', () => {
  it('slides the transcript back when closing at the end clamps the scroll first', () => {
    const items = [
      item('prompt', 1, { role: 'user', text: 'Fix it' }),
      item('command', 1_001, { type: 'command', command: 'pnpm test', text: 'ok' }),
      item('answer', 3_001, { role: 'assistant', phase: 'final_answer', text: 'Fixed.' }),
    ]
    const { container } = render(
      <Thread
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const runway = container.querySelector<HTMLElement>('.thread__runway')!
    const slides = vi.fn()
    runway.animate = slides as unknown as HTMLElement['animate']
    const summary = screen.getByRole('button', { name: /Worked for/ })
    const reveal = container.querySelector('.activity__reveal')!
    const settle = () =>
      fireEvent(
        reveal,
        Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }),
      )

    fireEvent.click(summary)
    settle()
    // Scrolled to the very end: the shorter runway will clamp the position.
    const scroller = container.querySelector<HTMLElement>('.thread')!
    scroller.scrollTop = layout.committed - VIEWPORT
    fireEvent.scroll(scroller)
    const before = scroller.scrollTop
    slides.mockClear()

    fireEvent.click(summary)

    const shift = scroller.scrollTop - before
    expect(shift).toBe(ROW - OPEN_ROW)
    expect(slides).toHaveBeenCalledWith(
      [{ transform: `translateY(${shift}px)` }, { transform: 'none' }],
      expect.objectContaining({ id: 'reveal-slide' }),
    )
  })

  const answered = [
    item('prompt', 1, { role: 'user', text: 'Fix it' }),
    item('command', 1_001, { type: 'command', command: 'pnpm test', text: 'ok' }),
    item('answer', 3_001, { role: 'assistant', phase: 'final_answer', text: 'Fixed.' }),
  ]

  function renderWithSlides(items: Item[], diff?: string) {
    const store = new ThreadFrameStore({ ...emptyThread, items, diff })
    const { container } = render(
      <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
    )
    const runway = container.querySelector<HTMLElement>('.thread__runway')!
    // Like the browser: the runway starts its slide below its place, and that
    // transform extends the scrollable overflow until the slide settles.
    const slides = vi.fn((keyframes: Keyframe[]) => {
      layout.overflow = Math.max(0, Number.parseFloat(String(keyframes[0]!['transform']).slice(11)))
      return { cancel: () => undefined }
    })
    runway.animate = slides as unknown as HTMLElement['animate']
    const scroller = container.querySelector<HTMLElement>('.thread')!
    return { store, container, runway, slides, scroller }
  }

  it('opens upward: the text below holds still while the summary rises', () => {
    layout.openRow = ROW + 100
    layout.summaryTop = 150
    const { store, slides, scroller } = renderWithSlides(answered)
    expect(scroller.scrollTop).toBe(layout.committed - VIEWPORT)

    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))

    expect(slides).toHaveBeenCalledWith(
      [{ transform: 'translateY(100px)' }, { transform: 'none' }],
      expect.objectContaining({ id: 'reveal-slide' }),
    )
    expect(layout.overflow).toBe(100)
    expect(scroller.scrollTop).toBe(layout.committed - VIEWPORT)

    // A render mid-slide (a streamed delta, the virtualizer's range update)
    // must not follow the inflated scroll height: that jumped the viewport
    // past the end for one frame and back on the next.
    act(() => store.publish({ ...emptyThread, items: [...answered] }))

    expect(scroller.scrollTop).toBe(layout.committed - VIEWPORT)
    expectFollowing(store, answered, scroller)
  })

  it('pushes the rest down, what follows the transcript included, once the summary meets the top', () => {
    layout.openRow = ROW + 100
    // Only 8px of room above the summary for 100px of details.
    layout.summaryTop = 20
    const { container, scroller } = renderWithSlides(
      answered,
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b',
    )
    const after = container.querySelector<HTMLElement>('.thread__runway')!.nextElementSibling
    expect(after).toBeInstanceOf(HTMLElement)
    const slide = vi.fn(() => ({ cancel: () => undefined }))
    ;(after as HTMLElement).animate = slide as unknown as HTMLElement['animate']
    const before = scroller.scrollTop

    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))

    expect(scroller.scrollTop - before).toBe(8)
    // Committed in one step, so it starts 92px up and travels with the rows.
    expect(slide).toHaveBeenCalledWith(
      [{ transform: 'translateY(-92px)' }, { transform: 'none' }],
      expect.objectContaining({ id: 'reveal-slide' }),
    )
  })

  /** Still following the end: new content scrolls into view without a jump. */
  function expectFollowing(store: ThreadFrameStore, items: Item[], scroller: HTMLElement) {
    expect(jumpButton()).toBeNull()
    const before = maxScrollTop()
    act(() =>
      store.publish({
        ...emptyThread,
        items: [...items, item('next', 4_001, { role: 'user', text: 'And the docs?' })],
      }),
    )
    expect(maxScrollTop()).toBeGreaterThan(before)
    expect(scroller.scrollTop).toBe(maxScrollTop())
    expect(jumpButton()).toBeNull()
  }

  function renderOpenAtEnd() {
    const items = [
      item('prompt', 1, { role: 'user', text: 'Fix it' }),
      item('command', 1_001, { type: 'command', command: 'pnpm test', text: 'ok' }),
      item('answer', 3_001, { role: 'assistant', phase: 'final_answer', text: 'Fixed.' }),
    ]
    const store = new ThreadFrameStore({ ...emptyThread, items })
    const { container } = render(
      <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
    )
    const summary = screen.getByRole('button', { name: /Worked for/ })
    const reveal = container.querySelector('.activity__reveal')!
    fireEvent.click(summary)
    fireEvent(
      reveal,
      Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'transform' }),
    )
    const scroller = container.querySelector<HTMLElement>('.thread')!
    scroller.scrollTop = maxScrollTop()
    fireEvent.scroll(scroller)
    return { items, store, scroller, summary }
  }

  const jumpButton = () => screen.queryByRole('button', { name: 'Jump to latest' })

  it('stays at the end when closing while the reveal still hangs below its summary', () => {
    const { items, store, scroller, summary } = renderOpenAtEnd()
    layout.closingOverflow = OPEN_ROW - ROW

    fireEvent.click(summary)

    expect(scroller.scrollTop).toBe(maxScrollTop())
    expectFollowing(store, items, scroller)
  })

  it('does not add its shift on top of a scroll the virtualizer already corrected', () => {
    const { items, store, scroller, summary } = renderOpenAtEnd()
    layout.correctScroll = true

    fireEvent.click(summary)

    expect(scroller.scrollTop).toBe(maxScrollTop())
    expectFollowing(store, items, scroller)
  })

  it('holds a tall reveal without offering a jump until new content arrives', () => {
    const items = [
      item('prompt', 1, { role: 'user', text: 'Fix it' }),
      item('command', 1_001, { type: 'command', command: 'pnpm test', text: 'ok' }),
      item('answer', 3_001, { role: 'assistant', phase: 'final_answer', text: 'Fixed.' }),
    ]
    const store = new ThreadFrameStore({ ...emptyThread, items })
    const { container } = render(
      <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
    )
    const scroller = container.querySelector<HTMLElement>('.thread')!
    expect(scroller.scrollTop).toBe(maxScrollTop())

    // 200px of details under a summary 38px below the top edge.
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))

    expect(scroller.scrollTop).toBeLessThan(maxScrollTop())
    expect(jumpButton()).toBeNull()

    act(() =>
      store.publish({
        ...emptyThread,
        items: [...items, item('next', 4_001, { role: 'user', text: 'And the docs?' })],
      }),
    )

    expect(jumpButton()).toBeTruthy()
  })

  it('offers the jump once the user scrolls away from a held reveal', () => {
    const items = [
      item('prompt', 1, { role: 'user', text: 'Fix it' }),
      item('command', 1_001, { type: 'command', command: 'pnpm test', text: 'ok' }),
      item('answer', 3_001, { role: 'assistant', phase: 'final_answer', text: 'Fixed.' }),
    ]
    const { container } = render(
      <Thread
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const scroller = container.querySelector<HTMLElement>('.thread')!
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    expect(jumpButton()).toBeNull()

    scroller.scrollTop -= 40
    fireEvent.scroll(scroller)

    expect(jumpButton()).toBeTruthy()
  })
})
