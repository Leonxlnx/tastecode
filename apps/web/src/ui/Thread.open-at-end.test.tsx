// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'

const VIEWPORT = 800
const ROW = 50
const TURNS = 150

/** Every row element the page ever rendered, by its index. */
let rendered: Set<number>

beforeEach(() => {
  rendered = new Set()
  const heightOf = (element: HTMLElement) => {
    if (element.classList.contains('thread')) return VIEWPORT
    return element.getAttribute('data-index') === null ? 0 : ROW
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
  // The list observes each row it mounts; record them all, whatever happens to them later.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(target: Element) {
        const index = target.getAttribute('data-index')
        if (index !== null) rendered.add(Number(index))
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function heldTranscript(): Item[] {
  const items: Item[] = []
  for (let turn = 0; turn < TURNS; turn += 1) {
    const base = { turnId: `turn-${turn}`, type: 'message', status: 'completed' } as const
    items.push({
      ...base,
      id: `prompt-${turn}`,
      role: 'user',
      text: `Question ${turn}`,
      createdAt: turn * 2,
    })
    items.push({
      ...base,
      id: `answer-${turn}`,
      role: 'assistant',
      text: `Answer ${turn}`,
      createdAt: turn * 2 + 1,
    })
  }
  return items
}

describe('Thread opened with a transcript the renderer holds', () => {
  it('renders the rows at its end, never the first screen it scrolls away from', () => {
    const items = heldTranscript()
    const store = new ThreadFrameStore({ ...emptyThread, items })
    const view = render(
      <Thread
        frameStore={store}
        threadId="held"
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    // The last exchange is on screen.
    expect(rendered.has(items.length - 1)).toBe(true)
    expect(view.container.textContent).toContain(`Answer ${TURNS - 1}`)
    // Nothing from the top of the chat was ever drawn on the way there.
    expect(rendered.has(0)).toBe(false)
    expect(Math.min(...rendered)).toBeGreaterThan(items.length - 60)
  })

  it('starts an empty chat at its top and still lands at the end once its rows arrive', () => {
    const store = new ThreadFrameStore(emptyThread)
    const view = render(
      <Thread
        frameStore={store}
        threadId="cold"
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    const items = heldTranscript().slice(0, 4)
    act(() => store.publish({ ...emptyThread, items }))
    expect(view.container.textContent).toContain('Answer 1')
  })
})
