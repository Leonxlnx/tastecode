// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, reduceDeltas, type ThreadState } from '../thread-store.js'
import { mockKeyboardModifierState } from '../test-keyboard.js'
import { TURN_TOP_GAP } from './scroll-mode.js'
import { Thread } from './Thread.js'

const layout = vi.hoisted(() => ({
  height: 1_200,
  count: 0,
  heightReads: 0,
  /** Where each row starts, for the rows a test places. */
  starts: [] as number[],
  /** The scroll function Thread gave the list, if any. */
  scrollToFn: undefined as ScrollToFn | undefined,
  /** How often the list's own scroll was written to the element. */
  listWrites: 0,
}))

type ScrollToFn = (
  offset: number,
  options: { adjustments?: number; behavior?: ScrollBehavior },
  instance: { scrollElement: HTMLElement | null },
) => void

/** The list's default: scroll the element to offset plus adjustments. */
const elementScroll: ScrollToFn = (offset, { adjustments = 0 }, instance) => {
  if (instance.scrollElement) instance.scrollElement.scrollTop = offset + adjustments
}

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
    get measurementsCache() {
      return layout.starts.map((start) => ({ start }))
    },
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }
  return {
    elementScroll: (...args: Parameters<ScrollToFn>) => {
      layout.listWrites += 1
      elementScroll(...args)
    },
    useVirtualizer: ({ count, scrollToFn }: { count: number; scrollToFn?: ScrollToFn }) => {
      layout.count = count
      layout.scrollToFn = scrollToFn
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
  layout.starts = []
  layout.listWrites = 0
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

    it('glides on from where the list corrected the scroll for a row above', async () => {
      const { view, scroller, grow } = streaming()
      grow(100)
      runFrame()
      runFrame()
      // Mid-glide, finished work above the reply collapses by 120 px. The list
      // moves the scroll up by as much, so the reply stays where it was.
      const before = scroller.scrollTop
      layout.height -= 120
      const scrollTo = layout.scrollToFn ?? elementScroll
      // The correction is written once the task that measured the row is done.
      await act(async () => scrollTo(before, { adjustments: -120 }, { scrollElement: scroller }))
      fireEvent.scroll(scroller)
      const corrected = scroller.scrollTop
      expect(corrected).toBe(before - 120)

      // The next update does not snap onto the end: the glide carries on.
      grow(0)
      expect(scroller.scrollTop).toBe(corrected)
      const tops = settle(scroller)
      expect(steps(corrected, tops).every((move) => move >= 0)).toBe(true)
      expect(scroller.scrollTop).toBe(980)
      expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    })

    it('writes the corrections for rows measured together once', async () => {
      const view = render(<Thread {...props()} threadId="corrections" />)
      const scroller = view.container.querySelector<HTMLElement>('.thread')!
      fireEvent.wheel(scroller, { deltaY: -100 })
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)
      const scrollTo = layout.scrollToFn!
      const instance = { scrollElement: scroller }
      layout.listWrites = 0

      // Three rows above the viewport measured taller in one observer callback.
      act(() => {
        scrollTo(400, { adjustments: 30 }, instance)
        scrollTo(430, { adjustments: 20 }, instance)
        scrollTo(450, { adjustments: 10 }, instance)
      })
      expect(layout.listWrites).toBe(0)
      await act(async () => undefined)
      expect(layout.listWrites).toBe(1)
      expect(scroller.scrollTop).toBe(460)

      // The list's own move is not the user's: they still read where they were.
      fireEvent.scroll(scroller)
      expect(view.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
      // A smooth scroll is written at once.
      act(() => scrollTo(100, { behavior: 'smooth' }, instance))
      expect(layout.listWrites).toBe(2)
    })

    it('reads no layout for the scroll events its own glide causes', () => {
      const { view, scroller, grow } = streaming()
      grow(60)
      runFrame()
      expect(scroller.scrollTop).toBeGreaterThan(1_000)
      const reads = vi.spyOn(Element.prototype, 'scrollTop', 'get')

      // The browser reports the glide's write in the next frame.
      reads.mockClear()
      fireEvent.scroll(scroller)
      expect(reads).not.toHaveBeenCalled()
      // Nothing was written since, so another event is not the glide's.
      fireEvent.scroll(scroller)
      expect(reads).toHaveBeenCalled()

      // A wheel turn may have moved the scroll as well.
      runFrame()
      fireEvent.wheel(scroller, { deltaY: 100 })
      reads.mockClear()
      fireEvent.scroll(scroller)
      expect(reads).toHaveBeenCalled()

      settle(scroller)
      expect(scroller.scrollTop).toBe(1_060)
      expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
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

  describe('taking over and handing back', () => {
    const jump = () => document.querySelector('.jump')
    /** The user turns the wheel and the transcript lands at `top`. */
    function wheelTo(scroller: HTMLElement, top: number) {
      fireEvent.wheel(scroller, { deltaY: top < scroller.scrollTop ? -100 : 100 })
      scroller.scrollTop = top
      fireEvent.scroll(scroller)
    }

    it('follows again when a scroll back down lands a line short of a growing end', () => {
      const { scroller, grow } = streaming()
      wheelTo(scroller, 700)
      expect(jump()).toBeTruthy()

      grow(20)
      // A smooth wheel fixed its target before that line arrived: 40px short.
      wheelTo(scroller, 980)

      expect(jump()).toBeNull()
      settle(scroller)
      expect(scroller.scrollTop).toBe(1_020)
      grow(20)
      settle(scroller)
      expect(scroller.scrollTop).toBe(1_040)
    })

    it('follows again when a flick to the end lands short of a burst that came with it', () => {
      const { scroller, grow } = streaming()
      wheelTo(scroller, 400)

      fireEvent.wheel(scroller, { deltaY: 3_000 })
      // A code block lands in the frame the scroll reaches the old end.
      grow(94)
      scroller.scrollTop = 1_000
      fireEvent.scroll(scroller)

      expect(jump()).toBeNull()
      settle(scroller)
      expect(scroller.scrollTop).toBe(1_094)
    })

    it('offers the jump only once the end is a real distance away', () => {
      const { scroller, grow } = streaming()
      wheelTo(scroller, 970)
      expect(jump()).toBeNull()

      grow(100)
      expect(jump()).toBeNull()
      expect(scroller.scrollTop).toBe(970)

      grow(40)
      expect(jump()).toBeTruthy()
    })

    it('withdraws the jump only once the end is close again', () => {
      const { scroller, grow } = streaming()
      wheelTo(scroller, 800)
      expect(jump()).toBeTruthy()

      wheelTo(scroller, 880)
      expect(jump()).toBeTruthy()
      wheelTo(scroller, 910)
      expect(jump()).toBeNull()
      // Back up, but not past the distance that offers it.
      wheelTo(scroller, 860)
      expect(jump()).toBeNull()

      // Still the user's position: a new line does not pull them down.
      grow(20)
      settle(scroller)
      expect(scroller.scrollTop).toBe(860)
    })

    it('never lets go just because the end moved away', () => {
      const { scroller, grow } = streaming()

      grow(500)
      // The virtual list corrects the scroll for a row it measured.
      scroller.scrollTop = 1_100
      fireEvent.scroll(scroller)

      expect(jump()).toBeNull()
      settle(scroller)
      expect(scroller.scrollTop).toBe(1_500)
    })

    it('lets a scroll key in the transcript take over, but not one typed into a field', () => {
      const { scroller, grow } = streaming()
      const field = document.createElement('textarea')
      scroller.firstElementChild!.append(field)

      fireEvent.keyDown(field, { key: 'PageUp' })
      grow(40)
      settle(scroller)
      expect(scroller.scrollTop).toBe(1_040)

      fireEvent.keyDown(scroller, { key: 'PageUp' })
      grow(20)
      runFrame()
      expect(scroller.scrollTop).toBe(1_040)
      scroller.scrollTop = 1_039
      fireEvent.scroll(scroller)
      grow(20)
      settle(scroller)

      expect(scroller.scrollTop).toBe(1_039)
    })
  })

  describe('a new turn', () => {
    /** The room left below a pinned turn, as written. */
    const room = (scroller: HTMLElement) =>
      Number.parseFloat(
        scroller.querySelector<HTMLElement>('.thread__turn-room')?.style.height ?? '',
      ) || 0

    beforeEach(() => {
      // The browser's heights: the column holds the content, and the scroll
      // also reaches through the room below it.
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return layout.height + room(this)
      })
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        const height = this.classList.contains('thread__col') ? layout.height : 0
        return {
          top: 0,
          height,
          bottom: height,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: 0,
        } as DOMRect
      })
    })

    const finished: Item[] = [
      { ...items[0]!, id: 'first-prompt', role: 'user', text: 'Hi', createdAt: 0 },
      items[0]!,
    ]

    /**
     * A finished chat open at its end. `send` starts a turn with a 60px
     * prompt and, like the app, asks for the end in the same render.
     */
    function chat() {
      layout.starts = [0, 600]
      let state: ThreadState = { ...emptyThread, items: finished }
      let reveal = 0
      const store = new ThreadFrameStore(state)
      const threadProps = props(store)
      const view = render(<Thread {...threadProps} threadId="pinned" revealRequest={reveal} />)
      const scroller = view.container.querySelector<HTMLElement>('.thread')!
      expect(scroller.scrollTop).toBe(1_000)
      now += 1_000
      const publish = (next: ThreadState) => {
        state = next
        act(() => store.publish(state))
      }
      const send = ({ asked = true } = {}) => {
        layout.height += 60
        layout.starts = [0, 600, 1_200]
        state = {
          ...state,
          items: [
            ...finished,
            {
              id: 'prompt',
              turnId: 'turn-2',
              type: 'message',
              role: 'user',
              status: 'completed',
              text: 'Explain it',
              createdAt: 3,
            },
          ],
          running: true,
          activeTurn: { id: 'turn-2', startedAt: 3 },
        }
        if (asked) reveal += 1
        act(() => {
          store.publish(state)
          view.rerender(<Thread {...threadProps} threadId="pinned" revealRequest={reveal} />)
        })
      }
      /** One more streamed line of the answer. */
      const line = () => {
        layout.height += 20
        layout.starts = [0, 600, 1_200, 1_260]
        const answer: Item = {
          id: 'answer-2',
          turnId: 'turn-2',
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: `${state.items[3]?.text ?? ''} line`,
          createdAt: 4,
        }
        publish({ ...state, items: [...state.items.slice(0, 3), answer] })
      }
      return { view, scroller, publish, send, line, current: () => state }
    }

    it('glides the prompt up to just below the top and leaves room for the answer', () => {
      const { scroller, send } = chat()

      send()
      // The room below makes the pinned position reachable: 1176 = 1200 - 24.
      expect(room(scroller)).toBe(1_176 - (1_260 - 200))
      const tops = settle(scroller)

      expect(scroller.scrollTop).toBe(1_200 - TURN_TOP_GAP)
      expect(tops.length).toBeGreaterThan(3)
      expect(steps(1_000, tops).every((move) => move >= 0)).toBe(true)
    })

    it('lets the answer fill the screen without moving, then follows it', () => {
      const { scroller, send, line } = chat()
      send()
      settle(scroller)
      const pinned = scroller.scrollTop

      // Five lines still fit between the prompt and the bottom edge.
      for (let lines = 0; lines < 5; lines += 1) {
        const before = room(scroller)
        line()
        expect(room(scroller)).toBe(before - 20)
        expect(scroller.scrollTop).toBe(pinned)
        settle(scroller)
        expect(scroller.scrollTop).toBe(pinned)
      }

      // The sixth reaches past it: the room is used up and the follow takes over.
      line()
      settle(scroller)
      expect(room(scroller)).toBe(0)
      expect(scroller.scrollTop).toBe(layout.height - 200)
    })

    it('keeps the answer where it is when the turn ends', () => {
      const { scroller, send, line, publish, current } = chat()
      send()
      settle(scroller)
      line()
      settle(scroller)
      const pinned = scroller.scrollTop

      // The finished turn changes its chrome; the room takes up the difference.
      layout.height += 36
      publish({ ...current(), running: false, activeTurn: undefined })
      settle(scroller)

      expect(scroller.scrollTop).toBe(pinned)
      expect(room(scroller)).toBeGreaterThan(0)
    })

    it('neither pins nor moves a turn that starts on its own while the user reads further up', () => {
      const { view, scroller, send } = chat()
      fireEvent.wheel(scroller, { deltaY: -100 })
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)

      // A queued message starting: nobody asked for the end just now.
      send({ asked: false })
      settle(scroller)

      expect(scroller.scrollTop).toBe(400)
      expect(room(scroller)).toBe(0)
      expect(view.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
    })

    it('lands at once on a prompt sent from further up than two screens', () => {
      const { view, scroller, send } = chat()
      fireEvent.wheel(scroller, { deltaY: -100 })
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)

      send()

      // 776px away in a 200px viewport: no glide through the whole chat.
      expect(scroller.scrollTop).toBe(1_200 - TURN_TOP_GAP)
      expect(frames).toHaveLength(0)
      expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    })

    it('opens the chat again at its own end, without the room', () => {
      const { view, scroller, send } = chat()
      send()
      settle(scroller)
      expect(room(scroller)).toBeGreaterThan(0)

      view.rerender(<Thread {...props(new ThreadFrameStore(emptyThread))} threadId="other" />)

      expect(room(scroller)).toBe(0)
    })
  })
})
