// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'

const layout = vi.hoisted(() => ({ height: 1_200, count: 0 }))

vi.mock('@tanstack/react-virtual', () => {
  // The real virtualizer keeps its identity when rows load or change size.
  const virtualizer = {
    getVirtualItems: () =>
      Array.from({ length: layout.count }, (_, index) => ({
        index,
        key: index,
        start: index * 72,
      })),
    getTotalSize: () => layout.height,
    measureElement: () => undefined,
    measurementsCache: [],
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }
  return {
    useVirtualizer: ({ count }: { count: number }) => {
      layout.count = count
      return virtualizer
    },
  }
})

const noop = () => undefined
const items: Item[] = [
  {
    id: 'answer',
    turnId: 'turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: 'Latest answer',
    createdAt: 1,
  },
]

function props(frameStore = new ThreadFrameStore({ ...emptyThread, items })) {
  return { frameStore, onDecide: noop, onAnswerUserInput: noop }
}

beforeEach(() => {
  layout.height = 1_200
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => layout.height)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Thread scroll position', () => {
  it('opens cached history at the bottom before any frame update', () => {
    const view = render(<Thread {...props()} threadId="cached" />)

    expect(view.container.querySelector('.thread')!.scrollTop).toBe(1_000)
  })

  it('opens at the bottom when history loads without a text frame update', () => {
    layout.height = 200
    const store = new ThreadFrameStore(emptyThread)
    const view = render(<Thread {...props(store)} threadId="loading" loading />)

    layout.height = 1_200
    act(() => store.publish({ ...emptyThread, items }))

    expect(view.container.querySelector('.thread')!.scrollTop).toBe(1_000)
  })

  it('keeps the bottom in view as virtual rows finish measuring', () => {
    const threadProps = props()
    const view = render(<Thread {...threadProps} />)
    const scroller = view.container.querySelector('.thread')!
    scroller.scrollTop = 1_000
    fireEvent.scroll(scroller)

    layout.height = 1_700
    view.rerender(<Thread {...threadProps} loading={false} />)

    expect(scroller.scrollTop).toBe(1_500)
  })

  it('lets the user scroll up while virtual rows finish measuring', () => {
    const threadProps = props()
    const view = render(<Thread {...threadProps} />)
    const scroller = view.container.querySelector('.thread')!
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)

    layout.height = 1_700
    view.rerender(<Thread {...threadProps} loading={false} />)

    expect(scroller.scrollTop).toBe(400)
    expect(view.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
  })

  it('opens the next chat at the bottom after the user scrolled up', () => {
    const view = render(<Thread key="first" {...props()} threadId="first" />)
    const scroller = view.container.querySelector('.thread')!
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)

    view.rerender(<Thread key="second" {...props()} threadId="second" />)

    expect(view.container.querySelector('.thread')!.scrollTop).toBe(1_000)
    expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })
})
