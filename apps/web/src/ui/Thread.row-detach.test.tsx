// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { Thread } from './Thread.js'

const VIEWPORT = 800
const ROWS = 400

beforeEach(() => {
  // Every row measures 0, as the hidden rows of a long work disclosure do, so
  // the list keeps all of them mounted.
  const heightOf = (element: HTMLElement) => (element.classList.contains('thread') ? VIEWPORT : 0)
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
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

describe('Thread rows leaving the list', () => {
  it('sweeps the rows a commit removed once, not once per removed row', async () => {
    const store = new ThreadFrameStore({ ...emptyThread, items: rows(ROWS) })
    const view = render(
      <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
    )
    const mounted = view.container.querySelectorAll('.thread__row').length
    expect(mounted).toBeGreaterThan(ROWS / 2)

    // The list checks each row it holds with isConnected when it sweeps.
    let checks = 0
    const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')!
    vi.spyOn(Node.prototype, 'isConnected', 'get').mockImplementation(function (this: Node) {
      checks += 1
      return connected.get!.call(this) as boolean
    })

    await act(async () => {
      store.publish({ ...emptyThread, items: rows(1) })
      await Promise.resolve()
    })

    expect(view.container.querySelectorAll('.thread__row')).toHaveLength(1)
    // One sweep over what was mounted, not mounted x mounted / 2.
    expect(checks).toBeLessThan(mounted * 4)
  })
})
