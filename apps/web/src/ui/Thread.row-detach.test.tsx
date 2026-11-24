// @vitest-environment happy-dom
import { StrictMode, type ReactElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'

const VIEWPORT = 800
const ROWS = 400

/** The real list, as Thread's last render got it. */
const captured = vi.hoisted(() => ({
  list: undefined as
    { elementsCache: Map<unknown, Element>; getMeasurements: () => { size: number }[] } | undefined,
}))
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...original,
    useVirtualizer: ((options: Parameters<typeof original.useVirtualizer>[0]) => {
      const list = original.useVirtualizer(options)
      captured.list = list as unknown as typeof captured.list
      return list
    }) as typeof original.useVirtualizer,
  }
})

/** Every element a ResizeObserver currently observes. */
let observed: Set<Element>
/** Height by row index; rows measure 0 unless given one here. */
let heights: Map<number, number>

beforeEach(() => {
  observed = new Set()
  heights = new Map()
  // Rows measure 0, as the hidden rows of a long work disclosure do, so the
  // list keeps all of them mounted.
  const heightOf = (element: HTMLElement) => {
    if (element.classList.contains('thread')) return VIEWPORT
    const index = element.getAttribute('data-index')
    return index === null ? 0 : (heights.get(Number(index)) ?? 0)
  }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(720)
  // A row whose key the list already sized is measured through its box.
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
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      #targets = new Set<Element>()
      observe(target: Element) {
        this.#targets.add(target)
        observed.add(target)
      }
      unobserve(target: Element) {
        this.#targets.delete(target)
        observed.delete(target)
      }
      disconnect() {
        for (const target of this.#targets) observed.delete(target)
        this.#targets.clear()
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  captured.list = undefined
})

function rows(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    turnId: 'turn',
    type: 'message',
    role: index % 2 === 0 ? 'user' : 'assistant',
    status: 'completed',
    text: `Message ${index}`,
    createdAt: index,
  }))
}

function rowElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.thread__row')]
}

function cachedElements(): Element[] {
  return [...captured.list!.elementsCache.values()]
}

describe.each([
  ['', (element: ReactElement) => element],
  [' under Strict Mode', (element: ReactElement) => <StrictMode>{element}</StrictMode>],
])('Thread rows leaving the list%s', (_, wrap) => {
  it('sweeps the rows a commit removed once, and lets go of exactly those', async () => {
    const store = new ThreadFrameStore({ ...emptyThread, items: rows(ROWS) })
    const view = render(
      wrap(
        <Thread
          frameStore={store}
          onDecide={() => undefined}
          onAnswerUserInput={() => undefined}
        />,
      ),
    )
    const before = rowElements(view.container)
    const mounted = before.length
    expect(mounted).toBeGreaterThan(ROWS / 2)
    for (const row of before) expect(observed.has(row)).toBe(true)

    // The list checks each row it holds with isConnected when it sweeps.
    let checks = 0
    const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')!
    const isConnected = vi.spyOn(Node.prototype, 'isConnected', 'get').mockImplementation(function (
      this: Node,
    ) {
      checks += 1
      return connected.get!.call(this) as boolean
    })

    await act(async () => {
      store.publish({ ...emptyThread, items: rows(1) })
      await Promise.resolve()
    })
    isConnected.mockRestore()

    // One sweep over what was mounted, not mounted x mounted / 2.
    expect(checks).toBeLessThan(mounted * 4)
    const after = rowElements(view.container)
    expect(after).toHaveLength(1)
    const survivor = after[0]!
    // The row that stays, measuring 0 like a hidden row, is still tracked.
    expect(survivor.isConnected).toBe(true)
    expect(observed.has(survivor)).toBe(true)
    expect(cachedElements()).toContain(survivor)
    // Every row that left is released by both the observer and the list.
    const removed = before.filter((row) => row !== survivor)
    expect(removed.length).toBe(mounted - 1)
    expect(removed.filter((row) => observed.has(row))).toEqual([])
    const cached = new Set(cachedElements())
    expect(removed.filter((row) => cached.has(row))).toEqual([])

    // A removed row's key comes back as a new node, observed and cached in place of the old one.
    const old = before.find((row) => row.getAttribute('data-index') === '1')!
    heights.set(1, 120)
    await act(async () => {
      store.publish({ ...emptyThread, items: rows(2) })
      await Promise.resolve()
    })
    const back = rowElements(view.container).find((row) => row.getAttribute('data-index') === '1')!
    expect(back).not.toBe(old)
    expect(observed.has(back)).toBe(true)
    expect(cachedElements()).toContain(back)
    expect(cachedElements()).not.toContain(old)
  })
})
