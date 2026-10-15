// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, type ThreadState } from '../thread-store.js'
import { mockKeyboardModifierState } from '../test-keyboard.js'
import { Thread } from './Thread.js'

const ROW = 100
const VIEWPORT = 200
const layout = vi.hoisted(() => ({
  count: 0,
  offset: null as number | null,
  scrollState: null as { index: number | null } | null,
  jumps: [] as number[],
}))

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
    // A scrollToIndex still settling, as virtual-core keeps it.
    get scrollState() {
      return layout.scrollState
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
    getOffsetForIndex: (index: number) => [index * ROW],
    scrollToIndex: (index: number) => layout.jumps.push(index),
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
  layout.scrollState = null
  layout.jumps = []
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
    // Every turn is loaded now, so nothing is left to announce.
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps a streaming turn anchored and a pending jump on its row as older rows arrive', () => {
    // The runway leaves a viewport below the last row, so a short turn can
    // sit at the top of the view.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => layout.count * ROW + VIEWPORT,
    )
    const prompt: Item = {
      id: 'prompt-15',
      turnId: 'turn-15',
      type: 'message',
      role: 'user',
      status: 'completed',
      text: 'Next question',
      createdAt: 15,
    }
    const streaming = (items: Item[], olderCursor?: string): ThreadState => ({
      ...paged([...items, prompt], olderCursor),
      running: true,
      activeTurn: { id: 'turn-15', startedAt: 15 },
      liveStart: items.length,
    })
    const store = new ThreadFrameStore(paged(turns(5, 15), 'cursor'))
    const view = render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={() => new Promise<void>(noop)}
      />,
    )
    const scroller = view.container.querySelector('.thread')!

    // Starting a turn at the bottom pins its prompt (row 10) to the top.
    act(() => store.publish(streaming(turns(5, 15), 'cursor')))
    expect(scroller.scrollTop).toBe(10 * ROW)

    layout.scrollState = { index: 12 }
    act(() => store.publish(streaming(turns(0, 15))))

    // The prompt is row 15 now. Following the old index would measure the
    // turn from row 10, find it taller than the viewport and let go of it.
    expect(scroller.scrollTop).toBe(15 * ROW)
    expect(layout.scrollState.index).toBe(17)
  })

  it('stops filling when a page read leaves the same cursor behind', async () => {
    const store = new ThreadFrameStore(paged(turns(0, 1), 'cursor'))
    // Resolves without publishing anything, as a read dropped for a stale
    // cursor does.
    const load = vi.fn(() => Promise.resolve())
    render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={load}
      />,
    )
    await act(async () => undefined)
    await act(async () => undefined)
    expect(load).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /Couldn’t load earlier messages/ })).toBeTruthy()
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
    expect(screen.getByRole('status').textContent).toBe('Couldn’t load earlier messages')
    expect(load).toHaveBeenCalledOnce()

    fireEvent.click(retry)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reads the complete history once for a search jump and lands on its turn', async () => {
    const store = new ThreadFrameStore(paged(turns(150, 160), 'cursor'))
    let finish: () => void = noop
    const loadComplete = vi.fn(
      (_threadId: string, _signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={() => new Promise<void>(noop)}
        onLoadCompleteHistory={loadComplete}
        searchJump={{ turnId: 'turn-3', request: 1 }}
      />,
    )
    expect(loadComplete).toHaveBeenCalledExactlyOnceWith('thread', expect.any(AbortSignal))
    expect(screen.getByRole('status').textContent).toContain('Loading earlier messages')

    // Live updates while the read is out do not ask again.
    act(() => store.publish(paged(turns(150, 161), 'cursor')))
    expect(loadComplete).toHaveBeenCalledOnce()
    expect(layout.jumps).toEqual([])

    await act(async () => {
      store.publish(paged(turns(0, 161)))
      finish()
    })
    expect(layout.jumps).toEqual([3])
    expect(loadComplete).toHaveBeenCalledOnce()
  })

  it('reports a search jump as done once it lands, and only once', async () => {
    const store = new ThreadFrameStore(paged(turns(150, 160), 'cursor'))
    let finish: () => void = noop
    const loadComplete = vi.fn(
      (_threadId: string, _signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const done = vi.fn()
    render(
      <StrictMode>
        <Thread
          frameStore={store}
          threadId="thread"
          onDecide={noop}
          onAnswerUserInput={noop}
          onLoadOlderHistory={() => new Promise<void>(noop)}
          onLoadCompleteHistory={loadComplete}
          searchJump={{ turnId: 'turn-3', request: 4 }}
          onSearchJumpDone={done}
        />
      </StrictMode>,
    )
    // Still waiting for the turn: the owner must keep the jump.
    expect(done).not.toHaveBeenCalled()

    await act(async () => {
      store.publish(paged(turns(0, 161)))
      finish()
    })
    expect(layout.jumps).toEqual([3])
    expect(done).toHaveBeenCalledExactlyOnceWith(4)

    act(() => store.publish(paged(turns(0, 162))))
    expect(done).toHaveBeenCalledOnce()
  })

  it('asks again for a search jump read that StrictMode cancelled while replaying effects', () => {
    const store = new ThreadFrameStore(paged(turns(150, 160), 'cursor'))
    const loadComplete = vi.fn((_threadId: string, _signal: AbortSignal) => new Promise<void>(noop))
    render(
      <StrictMode>
        <Thread
          frameStore={store}
          threadId="thread"
          onDecide={noop}
          onAnswerUserInput={noop}
          onLoadOlderHistory={() => new Promise<void>(noop)}
          onLoadCompleteHistory={loadComplete}
          searchJump={{ turnId: 'turn-3', request: 1 }}
        />
      </StrictMode>,
    )
    const signals = loadComplete.mock.calls.map(([, signal]) => signal)
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(screen.getByRole('status').textContent).toContain('Loading earlier messages')
  })

  it('offers a retry instead of asking again when a search jump read fails', async () => {
    const store = new ThreadFrameStore(paged(turns(150, 160), 'cursor'))
    let fail: (error: Error) => void = noop
    const loadComplete = vi.fn(
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
        onLoadOlderHistory={() => new Promise<void>(noop)}
        onLoadCompleteHistory={loadComplete}
        searchJump={{ turnId: 'turn-3', request: 1 }}
      />,
    )
    await act(async () => fail(new Error('offline')))
    const retry = screen.getByRole('button', { name: /Couldn’t load earlier messages/ })
    act(() => store.publish(paged(turns(150, 161), 'cursor')))
    expect(loadComplete).toHaveBeenCalledOnce()

    fireEvent.click(retry)
    expect(loadComplete).toHaveBeenCalledTimes(2)
  })

  it('announces only find while its read runs beside a page read', async () => {
    const store = new ThreadFrameStore(paged(turns(150, 151), 'cursor'))
    // The short transcript starts a page read that is still out when find opens.
    const loadOlder = vi.fn(() => new Promise<void>(noop))
    const loadComplete = vi.fn((_threadId: string, _signal: AbortSignal) => new Promise<void>(noop))
    render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={loadOlder}
        onLoadCompleteHistory={loadComplete}
      />,
    )
    expect(loadOlder).toHaveBeenCalledOnce()
    const announced = () =>
      screen
        .getAllByRole('status')
        .map((region) => region.textContent)
        .filter(Boolean)
    expect(announced()).toEqual(['Loading earlier messages'])

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const find = await screen.findByLabelText('Find in thread')
    fireEvent.change(find, { target: { value: 'Answer 3' } })
    expect(loadComplete).toHaveBeenCalledOnce()
    expect(announced()).toEqual(['Searching earlier messages'])
  })

  it('stops waiting for the complete read when find closes', async () => {
    const store = new ThreadFrameStore(paged(turns(150, 160), 'cursor'))
    const loadComplete = vi.fn((_threadId: string, _signal: AbortSignal) => new Promise<void>(noop))
    render(
      <Thread
        frameStore={store}
        threadId="thread"
        onDecide={noop}
        onAnswerUserInput={noop}
        onLoadOlderHistory={() => new Promise<void>(noop)}
        onLoadCompleteHistory={loadComplete}
      />,
    )
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const find = await screen.findByLabelText('Find in thread')
    fireEvent.change(find, { target: { value: 'Answer 3' } })
    expect(loadComplete).toHaveBeenCalledOnce()
    expect(screen.getByText('Searching…')).toBeTruthy()
    const signal = loadComplete.mock.calls[0]![1]
    expect(signal.aborted).toBe(false)

    fireEvent.keyDown(find, { key: 'Escape' })
    expect(signal.aborted).toBe(true)
    expect(screen.queryByLabelText('Find in thread')).toBeNull()
  })
})
