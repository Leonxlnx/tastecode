// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { mockKeyboardModifierState } from '../test-keyboard.js'
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
  mockKeyboardModifierState()
  layout.height = 1_200
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => layout.height)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Thread scroll position', () => {
  it('leaves Ctrl/Cmd+Alt+Arrow for chat switching', () => {
    const store = new ThreadFrameStore({
      ...emptyThread,
      items: [...items, { ...items[0]!, id: 'next-answer', turnId: 'next-turn', createdAt: 2 }],
    })
    render(<Thread {...props(store)} threadId="shortcuts" />)
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true, ...modifier })).toBe(true)
    }
    expect(fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })).toBe(false)
  })

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

  it('opens the next chat at the bottom even when the view is reused', () => {
    const view = render(<Thread {...props()} threadId="first" />)
    const scroller = view.container.querySelector('.thread')!
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)

    view.rerender(<Thread {...props()} threadId="second" />)

    expect(view.container.querySelector('.thread')!.scrollTop).toBe(1_000)
    expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('follows late content and viewport resizes but stops when the user scrolls up', () => {
    let resize: ResizeObserverCallback | undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function (callback) {
      resize = callback
      return { observe, disconnect, unobserve: noop }
    })
    const view = render(<Thread {...props()} threadId="saved" />)
    const scroller = view.container.querySelector('.thread')!
    expect(observe).toHaveBeenCalledWith(scroller)
    expect(observe).toHaveBeenCalledWith(scroller.firstElementChild)

    layout.height = 1_700
    act(() => resize?.([], {} as ResizeObserver))
    expect(scroller.scrollTop).toBe(1_500)

    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    layout.height = 2_000
    act(() => resize?.([], {} as ResizeObserver))
    expect(scroller.scrollTop).toBe(400)

    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  describe('Jump to latest', () => {
    let frames: FrameRequestCallback[]
    let now: number
    const runFrame = () => {
      now += 16
      const due = frames.splice(0)
      act(() => due.forEach((callback) => callback(now)))
    }

    beforeEach(() => {
      frames = []
      now = 0
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
        frames = []
      })
      // A native smooth scroll would only glide to the end it saw at the click.
      vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(() => undefined)
    })

    function scrolledUp() {
      const view = render(<Thread {...props()} threadId="jump" />)
      const scroller = view.container.querySelector('.thread')!
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)
      frames = []
      return { view, scroller }
    }

    it('lands at the end of a reply that keeps growing during the glide', () => {
      const { view, scroller } = scrolledUp()

      fireEvent.click(view.getByRole('button', { name: 'Jump to latest' }))
      const tops: number[] = []
      for (let frame = 0; frame < 120 && frames.length > 0; frame += 1) {
        // The answer grows by about one line every few frames.
        if (frame % 3 === 0) layout.height += 20
        runFrame()
        tops.push(scroller.scrollTop)
      }

      expect(frames).toHaveLength(0)
      expect(scroller.scrollTop).toBe(layout.height - 200)
      expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
      // A glide, not a single jump, and never backwards.
      expect(tops.length).toBeGreaterThan(3)
      expect(tops.every((top, index) => index === 0 || top >= tops[index - 1]!)).toBe(true)

      // From there on the end is followed as usual.
      layout.height += 300
      view.rerender(<Thread {...props()} threadId="jump" loading={false} />)
      expect(scroller.scrollTop).toBe(layout.height - 200)
    })

    it('stops the glide when the user scrolls during it', () => {
      const { view, scroller } = scrolledUp()

      fireEvent.click(view.getByRole('button', { name: 'Jump to latest' }))
      runFrame()
      runFrame()
      const reached = scroller.scrollTop
      expect(reached).toBeGreaterThan(400)
      fireEvent.wheel(scroller, { deltaY: -120 })
      runFrame()

      expect(frames).toHaveLength(0)
      expect(scroller.scrollTop).toBe(reached)
      expect(view.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
    })
  })
})
