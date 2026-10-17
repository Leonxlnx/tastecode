// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
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
