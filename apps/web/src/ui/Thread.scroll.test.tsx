// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, reduceDeltas, type ThreadState } from '../thread-store.js'
import { mockKeyboardModifierState } from '../test-keyboard.js'
import { Thread } from './Thread.js'

const layout = vi.hoisted(() => ({ height: 1_200, count: 0, heightReads: 0 }))

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

/** happy-dom's emulated device, for prefers-reduced-motion. */
const device = (
  window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }
).happyDOM.settings.device

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

/** Animation frames run by hand, on a clock the test owns. */
let frames: FrameRequestCallback[]
let now: number
const runFrame = () => {
  now += 16
  const due = frames.splice(0)
  act(() => due.forEach((callback) => callback(now)))
}
/** Runs frames until nothing asks for another one; returns scrollTop after each. */
function settle(scroller: HTMLElement, limit = 200): number[] {
  const tops: number[] = []
  for (let frame = 0; frame < limit && frames.length > 0; frame += 1) {
    runFrame()
    tops.push(scroller.scrollTop)
  }
  return tops
}
const steps = (from: number, tops: number[]) =>
  tops.map((top, index) => top - (index === 0 ? from : tops[index - 1]!))

beforeEach(() => {
  mockKeyboardModifierState()
  layout.height = 1_200
  layout.heightReads = 0
  frames = []
  now = 1_000
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
    layout.heightReads += 1
    return layout.height
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  device.prefersReducedMotion = 'no-preference'
})

/**
 * A turn streaming into a chat that is open at its end. `grow` is one text
 * frame after which the virtual list reports the reply that much taller.
 */
function streaming() {
  let state: ThreadState = {
    ...emptyThread,
    items: [
      {
        id: 'prompt',
        turnId: 'turn',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Explain it',
        createdAt: 1,
      },
      {
        id: 'answer',
        turnId: 'turn',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: 'It',
        createdAt: 2,
      },
    ],
    running: true,
    activeTurn: { id: 'turn', startedAt: 1 },
  }
  const store = new ThreadFrameStore(state)
  const view = render(<Thread {...props(store)} threadId="live" />)
  const scroller = view.container.querySelector<HTMLElement>('.thread')!
  // Past the moment the rows measure themselves in after opening.
  now += 1_000
  const grow = (px: number) => {
    layout.height += px
    state = reduceDeltas(state, [
      { type: 'item.delta', turnId: 'turn', itemId: 'answer', textDelta: ' and more' },
    ])
    act(() => store.publish(state))
  }
  return { view, scroller, grow }
}

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

  describe('following a streamed reply', () => {
    it('glides a new line into view instead of jumping by it', () => {
      const { scroller, grow } = streaming()
      expect(scroller.scrollTop).toBe(1_000)

      grow(20)
      // Nothing jumps in the frame the line arrives.
      expect(scroller.scrollTop).toBe(1_000)
      const tops = settle(scroller)

      const moves = steps(1_000, tops)
      expect(moves.filter((move) => move > 0).length).toBeGreaterThanOrEqual(5)
      expect(Math.max(...moves)).toBeLessThanOrEqual(6)
      expect(moves.every((move) => move >= 0)).toBe(true)
      expect(scroller.scrollTop).toBe(1_020)
      expect(frames).toHaveLength(0)
    })

    it('never overshoots a burst of lines', () => {
      const { scroller, grow } = streaming()

      grow(20)
      runFrame()
      grow(20)
      runFrame()
      grow(20)
      const tops = settle(scroller)

      expect(Math.max(...tops)).toBe(1_060)
      expect(steps(1_000, tops).every((move) => move >= 0)).toBe(true)
      expect(scroller.scrollTop).toBe(1_060)
    })

    it('follows a reply that shrank in the same frame', () => {
      const { scroller, grow } = streaming()
      grow(100)
      runFrame()
      runFrame()

      grow(-184)

      expect(scroller.scrollTop).toBe(916)
      settle(scroller)
      expect(scroller.scrollTop).toBe(916)
    })

    it('keeps the end in view at once with reduced motion', () => {
      device.prefersReducedMotion = 'reduce'
      const { scroller, grow } = streaming()

      grow(20)

      expect(scroller.scrollTop).toBe(1_020)
    })

    it('follows streamed frames without reading layout', () => {
      const { scroller, grow } = streaming()
      const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      const styles = vi.spyOn(window, 'getComputedStyle')
      layout.heightReads = 0

      for (let line = 0; line < 4; line += 1) {
        grow(20)
        runFrame()
        runFrame()
      }
      settle(scroller)

      expect(scroller.scrollTop).toBe(1_080)
      const transcript: unknown[] = [scroller, scroller.firstElementChild]
      expect(rects.mock.contexts.filter((element) => transcript.includes(element))).toEqual([])
      expect(styles.mock.calls.filter(([element]) => transcript.includes(element))).toEqual([])
      expect(layout.heightReads).toBe(0)
    })

    it('lets go when the wheel turns up during a glide', () => {
      const { view, scroller, grow } = streaming()
      grow(60)
      runFrame()
      runFrame()
      const reached = scroller.scrollTop
      expect(reached).toBeGreaterThan(1_000)

      fireEvent.wheel(scroller, { deltaY: -100 })
      // A line arriving before the wheel's scroll does must not pull back.
      grow(20)
      runFrame()
      expect(scroller.scrollTop).toBe(reached)
      // The wheel's scroll arrives a frame later.
      scroller.scrollTop = reached - 100
      fireEvent.scroll(scroller)
      now += 500
      grow(20)
      settle(scroller)

      expect(scroller.scrollTop).toBe(reached - 100)
      expect(view.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
    })

    it('keeps following when the wheel turns down', () => {
      const { scroller, grow } = streaming()
      grow(40)
      runFrame()

      fireEvent.wheel(scroller, { deltaY: 100 })
      settle(scroller)

      expect(scroller.scrollTop).toBe(1_040)
    })

    it('holds still while a pointer is down and catches up when it is released', () => {
      const { scroller, grow } = streaming()

      fireEvent.pointerDown(scroller, { pointerType: 'mouse' })
      grow(40)
      settle(scroller)
      expect(scroller.scrollTop).toBe(1_000)

      fireEvent.pointerUp(window)
      settle(scroller)

      expect(scroller.scrollTop).toBe(1_040)
    })

    it('writes the end at once while nothing is streaming', () => {
      const view = render(<Thread {...props()} threadId="idle" />)
      const scroller = view.container.querySelector('.thread')!
      now += 1_000

      layout.height += 20
      view.rerender(<Thread {...props()} threadId="idle" loading={false} />)

      expect(scroller.scrollTop).toBe(1_020)
      expect(frames).toHaveLength(0)
    })
  })

  describe('Jump to latest', () => {
    function scrolledUp() {
      const view = render(<Thread {...props()} threadId="jump" />)
      const scroller = view.container.querySelector('.thread')!
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)
      frames = []
      return { view, scroller }
    }

    it('lands at the end of a reply that keeps growing during the glide', () => {
      const { view, scroller, grow } = streaming()
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)

      fireEvent.click(view.getByRole('button', { name: 'Jump to latest' }))
      const tops: number[] = []
      for (let frame = 0; frame < 45; frame += 1) {
        // The answer grows by about one line every few frames.
        if (frame % 3 === 0) grow(20)
        runFrame()
        tops.push(scroller.scrollTop)
      }
      tops.push(...settle(scroller))

      expect(frames).toHaveLength(0)
      expect(scroller.scrollTop).toBe(layout.height - 200)
      expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
      // A glide, not a single jump, and never backwards.
      expect(tops.length).toBeGreaterThan(3)
      expect(steps(400, tops).every((move) => move >= 0)).toBe(true)
      // It slows into the end instead of stopping at full speed.
      expect(
        steps(400, tops)
          .filter((move) => move > 0)
          .at(-1),
      ).toBeLessThanOrEqual(2)

      // From there on the end is followed as usual.
      grow(300)
      settle(scroller)
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
