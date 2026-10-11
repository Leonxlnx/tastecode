// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, type ThreadState } from '../thread-store.js'
import { mockKeyboardModifierState } from '../test-keyboard.js'
import { Thread } from './Thread.js'

const ROW = 100
const VIEWPORT = 200
const layout = vi.hoisted(() => ({ count: 0, offset: null as number | null }))

vi.mock('@tanstack/react-virtual', () => {
  // Fixed-height rows; the scroll offset is the virtualizer's own value, which
  // only follows the element when it sees a scroll event.
  const virtualizer = {
    get scrollOffset() {
      return layout.offset
    },
    set scrollOffset(offset: number | null) {
      layout.offset = offset
    },
    getVirtualItems: () =>
      Array.from({ length: layout.count }, (_, index) => ({
        index,
        key: index,
        start: index * ROW,
      })),
    getVirtualItemForOffset: (offset: number) => {
      const index = Math.min(layout.count - 1, Math.floor(offset / ROW))
      return { index, key: index, start: index * ROW }
    },
    getTotalSize: () => layout.count * ROW,
    get measurementsCache() {
      return Array.from({ length: layout.count }, (_, index) => ({
        index,
        start: index * ROW,
        size: ROW,
      }))
    },
    measureElement: () => undefined,
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

function message(turn: number): Item {
  return {
    id: `answer-${turn}`,
    turnId: `turn-${turn}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: `Answer ${turn}`,
    createdAt: turn,
  }
}

function turns(from: number, to: number): Item[] {
  return Array.from({ length: to - from }, (_, index) => message(from + index))
}

function paged(items: Item[], olderCursor?: string): ThreadState {
  return { ...emptyThread, items, ...(olderCursor ? { olderCursor } : {}) }
}

function scrollTo(scroller: Element, top: number) {
  scroller.scrollTop = top
  layout.offset = top
  fireEvent.scroll(scroller)
}

beforeEach(() => {
  mockKeyboardModifierState()
  layout.offset = null
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
    () => layout.count * ROW,
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Thread older history', () => {
  it('loads older turns near the top and keeps the reader on the same row', () => {
    const store = new ThreadFrameStore(paged(turns(5, 15), 'cursor'))
    const load = vi.fn(() => new Promise<void>(noop))
    const view = render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={load}
      />,
    )
    const scroller = view.container.querySelector('.thread')!
    expect(load).not.toHaveBeenCalled()

    // Row 2, 50 pixels in: inside the prefetch distance.
    scrollTo(scroller, 250)
    expect(load).toHaveBeenCalledExactlyOnceWith('thread', undefined)
    expect(screen.getByRole('status').textContent).toContain('Loading earlier messages')

    act(() => store.publish(paged(turns(0, 15))))

    // Five rows arrived above; the same row stays 50 pixels in.
    expect(scroller.scrollTop).toBe(750)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('fills a short transcript and offers a retry when a page fails', async () => {
    const store = new ThreadFrameStore(paged(turns(0, 1), 'cursor'))
    let fail: (error: Error) => void = noop
    const load = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject
        }),
    )
    render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={load}
      />,
    )
    expect(load).toHaveBeenCalledOnce()

    await act(async () => fail(new Error('offline')))
    const retry = screen.getByRole('button', { name: /Couldn’t load earlier messages/ })
    expect(load).toHaveBeenCalledOnce()

    fireEvent.click(retry)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
