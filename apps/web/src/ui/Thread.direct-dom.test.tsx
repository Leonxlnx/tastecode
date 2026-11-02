// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'

/** One call per transcript render: the real virtual list, counted. */
const transcriptRenders = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: ((options: Parameters<typeof actual.useVirtualizer>[0]) => {
      transcriptRenders()
      return actual.useVirtualizer(options)
    }) as typeof actual.useVirtualizer,
  }
})

import { Thread } from './Thread.js'

const VIEWPORT = 800
/** Row heights by index; the stubbed layout reads them. */
let heights: number[] = []
/** Every ResizeObserver the page made, with what it watches. */
let observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = []

/** The virtual list's own observer reports `row` at its height now, as the browser would after layout. */
function measured(row: Element) {
  const observer = observers.find((entry) => entry.targets.has(row))
  expect(observer).toBeDefined()
  const blockSize = heights[Number(row.getAttribute('data-index'))]!
  act(() =>
    observer!.callback(
      [{ target: row, borderBoxSize: [{ blockSize, inlineSize: 720 }] } as never],
      {} as ResizeObserver,
    ),
  )
}

beforeEach(() => {
  heights = []
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private entry: { callback: ResizeObserverCallback; targets: Set<Element> }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() }
        observers.push(this.entry)
      }
      observe(target: Element) {
        this.entry.targets.add(target)
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target)
      }
      disconnect() {
        this.entry.targets.clear()
      }
    },
  )
  const heightOf = (element: HTMLElement) => {
    if (element.classList.contains('thread')) return VIEWPORT
    const index = element.getAttribute('data-index')
    return index === null ? 0 : (heights[Number(index)] ?? 0)
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
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function item(id: string, fields: Partial<Item>): Item {
  return {
    id,
    turnId: 'turn',
    type: 'message',
    status: 'completed',
    createdAt: 1,
    ...fields,
  } as Item
}

function streamingThread() {
  const items = [
    item('prompt', { role: 'user', text: 'Explain the fix' }),
    item('answer', { role: 'assistant', status: 'started', text: 'It' }),
  ]
  heights = [60, 40]
  const store = new ThreadFrameStore({
    ...emptyThread,
    items,
    running: true,
    activeTurn: { id: 'turn', startedAt: 1 },
  })
  const view = render(
    <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
  )
  const rows = () => [...view.container.querySelectorAll<HTMLElement>('.thread__row')]
  const runway = view.container.querySelector<HTMLElement>('.thread__runway')!
  const rail = view.container.querySelector<HTMLElement>('.thread__rail')!
  return { view, rows, runway, rail }
}

const total = () => heights.reduce((sum, height) => sum + height, 0)

describe('Thread virtual rows', () => {
  it('grows the live row line by line without rendering the transcript', () => {
    const { rows, runway } = streamingThread()
    const answer = rows()[1]!
    expect(runway.style.height).toBe(`${total()}px`)
    const before = transcriptRenders.mock.calls.length

    for (let line = 0; line < 5; line += 1) {
      heights[1]! += 20
      measured(answer)
      // The runway has the new height in the same callback that measured it.
      expect(runway.style.height).toBe(`${total()}px`)
    }

    expect(transcriptRenders.mock.calls.length - before).toBeLessThanOrEqual(2)
  })

  it('keeps the working rail room in the runway until the first response row takes it', () => {
    heights = [60]
    const prompt = item('prompt', { role: 'user', text: 'Explain the fix' })
    const running = { running: true, activeTurn: { id: 'turn', startedAt: 1 } }
    const store = new ThreadFrameStore({ ...emptyThread, items: [prompt], ...running })
    const view = render(
      <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
    )
    const runway = view.container.querySelector<HTMLElement>('.thread__runway')!
    const rail = view.container.querySelector<HTMLElement>('.thread__rail')!
    // The rail's 42px sit at the end of the runway, under the rail.
    expect(runway.style.height).toBe('102px')
    expect(rail.style.transform).toBe('translateY(60px)')

    // The answer row pads its top by the same 42px for the rail.
    heights = [60, 82]
    act(() =>
      store.publish({
        ...emptyThread,
        items: [prompt, item('answer', { role: 'assistant', status: 'started', text: 'It' })],
        ...running,
      }),
    )

    expect(runway.style.height).toBe('142px')
    expect(rail.style.transform).toBe('translateY(60px)')
    expect(view.container.querySelector('.thread__rail-spacer')).toBeNull()
  })

  it('reads the heights of the rows a commit mounted before it places any of them', () => {
    heights = [333, 211, 287, 199, 341, 263]
    const items = heights.map((_, index) =>
      item(`row-${index}`, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `Message ${index}`,
        createdAt: index,
      }),
    )
    // Each read, with the runway height it found: a height written between
    // two reads would have laid the transcript out again.
    const reads: string[] = []
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('thread')) return VIEWPORT
      const index = this.getAttribute('data-index')
      if (index === null) return 0
      reads.push(this.closest<HTMLElement>('.thread__runway')!.style.height)
      return heights[Number(index)] ?? 0
    })
    const store = new ThreadFrameStore({ ...emptyThread, items: items.slice(0, 1) })
    const view = render(
      <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
    )
    reads.length = 0

    // The rest of the chat arrives in one commit.
    act(() => store.publish({ ...emptyThread, items }))

    expect(reads).toHaveLength(heights.length - 1)
    expect(new Set(reads).size).toBe(1)
    const runway = view.container.querySelector<HTMLElement>('.thread__runway')!
    expect(runway.style.height).toBe(`${total()}px`)
    const rows = view.container.querySelectorAll<HTMLElement>('.thread__row')
    expect(rows[5]!.style.transform).toBe(`translate3d(0, ${total() - heights[5]!}px, 0)`)
  })

  it('follows rows that one observer callback measured once, after the callback', async () => {
    // A finished chat open at its end, three viewports long.
    heights = Array.from({ length: 30 }, () => 100)
    const items = heights.map((_, index) =>
      item(`row-${index}`, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `Message ${index}`,
        createdAt: index,
      }),
    )
    let top = 0
    let writes = 0
    let heightReads = 0
    vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(() => top)
    vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation((next: number) => {
      writes += 1
      top = next
    })
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      heightReads += 1
      const runway = this.querySelector<HTMLElement>('.thread__runway')
      return runway ? Number.parseFloat(runway.style.height) : 0
    })
    const store = new ThreadFrameStore({ ...emptyThread, items })
    const view = render(
      <Thread
        frameStore={store}
        threadId="long"
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const scroller = view.container.querySelector<HTMLElement>('.thread')!
    // The list learns where the chat opened and lays out the rows there.
    fireEvent.scroll(scroller)
    await act(async () => undefined)
    const end = top
    expect(end).toBe(total() - VIEWPORT)

    // The last three rows grew, reported together.
    const rows = [27, 28, 29].map((index) =>
      view.container.querySelector<HTMLElement>(`.thread__row[data-index="${index}"]`)!,
    )
    const observer = observers.find((entry) => rows.every((row) => entry.targets.has(row)))!
    for (const index of [27, 28, 29]) heights[index]! += 20
    writes = 0
    heightReads = 0
    act(() =>
      observer.callback(
        rows.map(
          (row) =>
            ({
              target: row,
              borderBoxSize: [{ blockSize: heights[Number(row.dataset.index)], inlineSize: 720 }],
            }) as never,
        ),
        {} as ResizeObserver,
      ),
    )
    expect(writes).toBe(0)
    await act(async () => undefined)

    expect(top).toBe(end + 60)
    expect(writes).toBe(1)
    expect(heightReads).toBe(1)
  })

  it('moves the rows and the working rail below a row that grew, without a render', () => {
    const { rows, rail } = streamingThread()
    const [prompt, answer] = rows()
    expect(answer!.style.transform).toBe('translate3d(0, 60px, 0)')
    expect(rail.style.transform).toBe('translateY(60px)')
    const before = transcriptRenders.mock.calls.length

    // An image in the prompt loaded.
    heights[0] = 180
    measured(prompt!)

    expect(answer!.style.transform).toBe('translate3d(0, 180px, 0)')
    expect(rail.style.transform).toBe('translateY(180px)')
    expect(transcriptRenders.mock.calls.length).toBe(before)
  })
})
