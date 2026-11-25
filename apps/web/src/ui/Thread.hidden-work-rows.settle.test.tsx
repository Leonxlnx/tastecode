// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, type ThreadState } from '../thread-store.js'

/** One call per transcript render: the real virtual list, counted. */
const transcriptRenders = vi.hoisted(() => vi.fn())
/**
 * Far above what the whole sequence needs (17 renders), far below what a render loop reaches.
 * A loop chained through microtasks never returns to `settle`, so the list's
 * render throws past this count instead.
 */
const RENDER_BOUND = vi.hoisted(() => 200)

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...actual,
    useVirtualizer: ((options: Parameters<typeof actual.useVirtualizer>[0]) => {
      transcriptRenders()
      if (transcriptRenders.mock.calls.length > RENDER_BOUND)
        throw new Error(`the transcript rendered more than ${RENDER_BOUND} times`)
      return actual.useVirtualizer(options)
    }) as typeof actual.useVirtualizer,
  }
})

import { Thread } from './Thread.js'

/**
 * The real virtual list over a laid-out page that answers like a browser: rows
 * have physical heights, every observer hears of a size it has not reported yet,
 * a changed scroll position fires a scroll event, and animation frames and
 * timers run when they are due. `settle` delivers all of that until nothing is
 * left, within a fixed number of rounds, so a render loop fails instead of hanging.
 */
const VIEWPORT = 800
const PROMPT = 60
const ANSWER = 120
const COLLAPSED = 46
const EXPANDED = 400
/** More than the 256 rows the overscan walks past zero-height rows. */
const OLD_GROUP = 600
const LAST_GROUP = 300
/** Far above what the whole sequence needs (4 writes), far below what a scroll loop reaches. */
const WRITE_BOUND = 100

let items: Item[] = []
let top = 0
let announcedTop = 0
let scrollWrites = 0
let frameRequests = 0
let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
let observers: {
  callback: ResizeObserverCallback
  targets: Set<Element>
  reported: Map<Element, number>
}[] = []

function heightOf(element: Element): number {
  if (element.classList.contains('thread')) return VIEWPORT
  if (!element.classList.contains('thread__row')) return 0
  if (element.classList.contains('is-suppressed')) return 0
  const activity = element.querySelector('.activity')
  if (activity) return activity.getAttribute('data-expanded') === 'true' ? EXPANDED : COLLAPSED
  const item = items[Number(element.getAttribute('data-index'))]
  return item?.type === 'message' && item.role === 'user' ? PROMPT : ANSWER
}

const runwayHeight = (container: HTMLElement) =>
  Number.parseFloat(container.querySelector<HTMLElement>('.thread__runway')!.style.height)

beforeEach(() => {
  items = []
  top = 0
  announcedTop = 0
  scrollWrites = 0
  frameRequests = 0
  frames = new Map()
  nextFrame = 1
  observers = []
  transcriptRenders.mockClear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private entry: (typeof observers)[number]
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set(), reported: new Map() }
        observers.push(this.entry)
      }
      observe(target: Element) {
        this.entry.targets.add(target)
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target)
        this.entry.reported.delete(target)
      }
      disconnect() {
        this.entry.targets.clear()
        this.entry.reported.clear()
      }
    },
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frameRequests += 1
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = heightOf(this)
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 720,
      bottom: height,
      width: 720,
      height,
      toJSON() {},
    } as DOMRect
  })
  // The scroll position stays within the runway, as a browser keeps it.
  const write = (element: Element, next: number) => {
    scrollWrites += 1
    const runway = element.querySelector<HTMLElement>('.thread__runway')
    const max = runway ? Math.max(0, Number.parseFloat(runway.style.height) - VIEWPORT) : 0
    top = Math.min(Math.max(0, next), max)
  }
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(() => top)
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    next: number,
  ) {
    write(this, next)
  })
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    const runway = this.querySelector<HTMLElement>('.thread__runway')
    return runway ? Number.parseFloat(runway.style.height) : 0
  })
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) write(this, options.top)
  } as Element['scrollTo']
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** What a due timer could have set off: a render, a scroll, a frame or a size to report. */
function activity(): string {
  const unreported = observers.some((observer) =>
    [...observer.targets].some(
      (target) => target.isConnected && observer.reported.get(target) !== heightOf(target),
    ),
  )
  return [transcriptRenders.mock.calls.length, scrollWrites, frameRequests, top, unreported].join()
}

/** Delivers microtasks, resize entries, scroll events, frames and due timers until none is left. */
async function settle(scroller: HTMLElement, rounds = 60): Promise<number> {
  for (let round = 0; round < rounds; round++) {
    let delivered = false
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    for (const observer of observers) {
      const entries: ResizeObserverEntry[] = []
      for (const target of observer.targets) {
        if (!target.isConnected) continue
        const size = heightOf(target)
        if (observer.reported.get(target) === size) continue
        observer.reported.set(target, size)
        entries.push({
          target,
          borderBoxSize: [{ blockSize: size, inlineSize: 720 }],
          contentRect: { height: size, width: 720 },
        } as never)
      }
      if (entries.length > 0) {
        delivered = true
        act(() => observer.callback(entries, {} as ResizeObserver))
      }
    }
    if (top !== announcedTop) {
      announcedTop = top
      delivered = true
      act(() => {
        scroller.dispatchEvent(new Event('scroll'))
      })
    }
    if (frames.size > 0) {
      delivered = true
      const due = [...frames.values()]
      frames.clear()
      const now = performance.now()
      act(() => {
        for (const callback of due) callback(now)
      })
    }
    // A due timer counts when it led to anything; a running turn's clock ticks on its own.
    if (!delivered && vi.getTimerCount() > 0) {
      const before = activity()
      act(() => {
        vi.advanceTimersByTime(250)
      })
      delivered = activity() !== before
    }
    if (!delivered) return round
  }
  throw new Error(`the transcript did not settle within ${rounds} rounds`)
}

function item(id: string, turnId: string, fields: Partial<Item>): Item {
  return { id, turnId, status: 'completed', createdAt: 1, ...fields } as Item
}

/** A prompt, `work` tool calls in one disclosure, and the answer. */
function workTurn(turnId: string, work: number, answer: Partial<Item> = {}): Item[] {
  return [
    item(`${turnId}-prompt`, turnId, { type: 'message', role: 'user', text: `Prompt ${turnId}` }),
    ...Array.from({ length: work }, (_, index) =>
      item(
        `${turnId}-work-${index}`,
        turnId,
        index % 2 === 0
          ? { type: 'command', command: `ls ${index}`, text: 'a\n', exitCode: 0 }
          : { type: 'tool_call', text: `Read {"file_path":"f${index}.ts"}` },
      ),
    ),
    item(`${turnId}-answer`, turnId, {
      type: 'message',
      role: 'assistant',
      text: `Answer ${turnId}`,
      ...answer,
    }),
  ]
}

function chat(lastRunning: boolean): ThreadState {
  const turns = [
    workTurn('t0', OLD_GROUP),
    ...Array.from({ length: 9 }, (_, index) => workTurn(`t${index + 1}`, 0)),
    workTurn('last', LAST_GROUP, lastRunning ? { status: 'started' } : {}),
  ]
  items = turns.flat()
  const turnTiming = Object.fromEntries(
    turns.map((turn) => [turn[0]!.turnId, { startedAt: 0, completedAt: 1 }]),
  )
  return {
    ...emptyThread,
    items,
    turnTiming,
    ...(lastRunning ? { running: true, activeTurn: { id: 'last', startedAt: 0 } } : {}),
  } as ThreadState
}

describe('hidden work rows with the real virtual list', () => {
  it('settle after open, finish, expand, collapse and the same rows coming back', async () => {
    const store = new ThreadFrameStore(chat(true))
    const view = render(
      <Thread
        frameStore={store}
        threadId="long"
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const { container } = view
    const scroller = container.querySelector<HTMLElement>('.thread')!
    const row = (index: number) =>
      container.querySelector<HTMLElement>(`.thread__row[data-index="${index}"]`)
    const start = (element: HTMLElement) =>
      Number(/translate3d\(0, (-?[\d.]+)px/.exec(element.style.transform)![1])
    const lastIndex = () => items.length - 1
    const leadIndex = 1
    const oldAnswer = OLD_GROUP + 1
    /** The last answer is on screen and the transcript ends at the viewport's end. */
    const atEnd = () => {
      const answer = row(lastIndex())!
      expect(answer.textContent).toContain('Answer last')
      expect(start(answer) + ANSWER).toBe(runwayHeight(container))
      expect(top).toBe(runwayHeight(container) - VIEWPORT)
    }

    // Opened at the estimated end while the last turn still works.
    await settle(scroller)
    expect(row(lastIndex())?.textContent).toContain('Answer last')
    expect(top).toBe(runwayHeight(container) - VIEWPORT)
    // The last turn's rows mounted and measured 0; the old group's never did.
    const measuredZero = container.querySelectorAll('.thread__row.is-suppressed').length
    expect(measuredZero).toBeGreaterThan(0)
    expect(row(leadIndex + 1)).toBeNull()

    // The turn finishes: its hidden rows are left out, the end stays in place.
    await act(async () => {
      store.publish(chat(false))
    })
    await settle(scroller)
    atEnd()
    expect(container.querySelectorAll('.thread__row.is-suppressed')).toHaveLength(0)

    // Up to the old disclosure: the reader scrolls to the top.
    top = 0
    await settle(scroller)
    const lead = row(leadIndex)!
    expect(lead.querySelector('.activity__summary')?.getAttribute('aria-expanded')).toBe('false')
    expect(start(lead)).toBe(PROMPT)
    expect(row(oldAnswer)?.textContent).toContain('Answer t0')
    expect(start(row(oldAnswer)!)).toBe(PROMPT + COLLAPSED)
    const collapsedTotal = runwayHeight(container)

    // Expanded: the details sit in the lead, the rows below move down, the header stays.
    await act(async () => {
      lead.querySelector<HTMLButtonElement>('.activity__summary')!.click()
    })
    await settle(scroller)
    expect(row(leadIndex)).toBe(lead)
    expect(lead.querySelector('.activity__summary')?.getAttribute('aria-expanded')).toBe('true')
    expect(lead.querySelector('.activity__body')?.textContent).toContain('ls 0')
    expect(start(lead) - top).toBe(PROMPT)
    expect(start(row(oldAnswer)!)).toBe(PROMPT + EXPANDED)
    expect(runwayHeight(container)).toBe(collapsedTotal + EXPANDED - COLLAPSED)
    expect(container.querySelectorAll('.thread__row.is-suppressed')).toHaveLength(0)

    // Collapsed again: the lead's measured height shrinks back.
    await act(async () => {
      lead.querySelector<HTMLButtonElement>('.activity__summary')!.click()
    })
    await settle(scroller)
    expect(lead.querySelector('.activity__summary')?.getAttribute('aria-expanded')).toBe('false')
    expect(start(lead) - top).toBe(PROMPT)
    expect(start(row(oldAnswer)!)).toBe(PROMPT + COLLAPSED)
    expect(runwayHeight(container)).toBe(collapsedTotal)

    // Away to the end and back: the same item keys mount again where they were.
    top = runwayHeight(container) - VIEWPORT
    await settle(scroller)
    expect(row(leadIndex)).toBeNull()
    atEnd()
    top = 0
    await settle(scroller)
    expect(row(leadIndex)?.querySelector('.activity__summary')?.getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(start(row(leadIndex)!)).toBe(PROMPT)
    expect(start(row(oldAnswer)!)).toBe(PROMPT + COLLAPSED)
    // The same rows published again as a new array.
    await act(async () => {
      store.publish({ ...chat(false), items: [...items] })
    })
    await settle(scroller)
    expect(start(row(oldAnswer)!)).toBe(PROMPT + COLLAPSED)
    expect(runwayHeight(container)).toBe(collapsedTotal)
    expect(container.querySelectorAll('.thread__row.is-suppressed')).toHaveLength(0)

    // Bounded work for all of it, and nothing more once input stopped.
    expect(transcriptRenders.mock.calls.length).toBeLessThan(RENDER_BOUND)
    expect(scrollWrites).toBeLessThan(WRITE_BOUND)
    const renders = transcriptRenders.mock.calls.length
    const writes = scrollWrites
    const requested = frameRequests
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(await settle(scroller)).toBe(0)
    expect(transcriptRenders.mock.calls.length).toBe(renders)
    expect(scrollWrites).toBe(writes)
    expect(frameRequests).toBe(requested)
    expect(frames.size).toBe(0)
    // Its own limit, whatever the run passes as the default.
  }, 20_000)
})
