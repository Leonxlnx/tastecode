// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import {
  appendUserMessage,
  beginOptimisticTurn,
  emptyThread,
  reduce,
  type ThreadState,
} from '../thread-store.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 72,
        end: (index + 1) * 72,
        size: 72,
      })),
    getTotalSize: () => count * 72,
    measurementsCache: [],
    measureElement: () => undefined,
    indexFromElement: (node: Element) => Number(node.getAttribute('data-index')),
    resizeItem: () => undefined,
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

import { Thread } from './Thread.js'

afterEach(cleanup)

const STEER_ID = 'local:steer'

const prompt: Item = {
  id: 'prompt',
  turnId: 'turn-1',
  type: 'message',
  role: 'user',
  status: 'completed',
  text: 'Build the landing page',
  createdAt: 1_000,
}
const reply: Item = {
  id: 'reply',
  turnId: 'turn-1',
  type: 'message',
  role: 'assistant',
  status: 'started',
  text: 'Setting up the project',
  createdAt: 2_000,
}

function apply(state: ThreadState, ...events: DomainEvent[]): ThreadState {
  return events.reduce(reduce, state)
}

/** A turn that is answering, then a prompt steered into it from the composer. */
function steeredTurn(): ThreadState {
  const answering = apply(
    emptyThread,
    {
      type: 'turn.started',
      turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 1_000 },
    },
    { type: 'item.completed', item: prompt },
    { type: 'item.started', item: reply },
  )
  return appendUserMessage(answering, 'Use pnpm instead', STEER_ID, 3_000)
}

function renderThread(state: ThreadState) {
  const frameStore = new ThreadFrameStore(state)
  const view = render(
    <Thread
      frameStore={frameStore}
      threadId="thread-1"
      onDecide={() => undefined}
      onAnswerUserInput={() => undefined}
    />,
  )
  return {
    ...view,
    frameStore,
    publish(next: ThreadState) {
      act(() => frameStore.publish(next))
    },
    spinners: () => view.container.querySelectorAll('.steer-pending'),
    spinnerRow: () =>
      view.container.querySelector('.steer-pending')?.closest('.thread__row') ?? undefined,
  }
}

describe('a steered prompt the agent has not answered yet', () => {
  it('shows the spinner under the prompt from the moment it is sent', () => {
    const view = renderThread(steeredTurn())

    expect(view.spinners()).toHaveLength(1)
    const row = view.spinnerRow()!
    expect(row.getAttribute('data-index')).toBe('2')
    expect(row.querySelector('.said__text')?.textContent).toBe('Use pnpm instead')
    // The transcript's own spinner, hidden from assistive technology like the others.
    expect(row.querySelector('.steer-pending')?.getAttribute('aria-hidden')).toBe('true')
    expect(row.querySelector('.steer-pending > .spinner > svg')).toBeTruthy()
  })

  it('keeps it while the server confirms the steer and the earlier reply streams on', () => {
    let state = steeredTurn()
    const view = renderThread(state)

    state = apply(state, {
      type: 'item.completed',
      item: {
        id: STEER_ID,
        turnId: 'turn-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Use pnpm instead',
        createdAt: 3_000,
      },
    })
    view.publish(state)
    expect(view.spinnerRow()?.getAttribute('data-index')).toBe('2')

    // Text for the reply above is not the agent taking up the steer.
    state = apply(state, {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'reply',
      textDelta: ' with npm',
    })
    view.publish(state)
    expect(view.spinnerRow()?.getAttribute('data-index')).toBe('2')

    // Nor is a reasoning row that shows nothing yet.
    state = apply(state, {
      type: 'item.started',
      item: {
        id: 'think',
        turnId: 'turn-1',
        type: 'reasoning',
        status: 'started',
        createdAt: 4_000,
      },
    })
    view.publish(state)
    expect(view.spinnerRow()?.getAttribute('data-index')).toBe('2')
  })

  it('moves to the newest steer when the user steers again', () => {
    const state = appendUserMessage(steeredTurn(), 'And skip the tests', 'local:again', 3_500)
    const view = renderThread(state)

    expect(view.spinners()).toHaveLength(1)
    expect(view.spinnerRow()?.getAttribute('data-index')).toBe('3')
  })

  it('clears once the agent adds its next row', () => {
    const state = steeredTurn()
    const view = renderThread(state)

    view.publish(
      apply(state, {
        type: 'item.started',
        item: {
          id: 'answer',
          turnId: 'turn-1',
          type: 'message',
          role: 'assistant',
          status: 'started',
          createdAt: 4_000,
        },
      }),
    )

    expect(view.spinners()).toHaveLength(0)
  })

  it('clears at once when the user stops the turn', () => {
    const state = steeredTurn()
    const view = renderThread(state)

    view.rerender(
      <Thread
        frameStore={view.frameStore}
        threadId="thread-1"
        stopping
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    expect(view.spinners()).toHaveLength(0)
  })

  it('clears when the turn ends without answering', () => {
    const state = steeredTurn()
    const view = renderThread(state)

    view.publish(
      apply(state, {
        type: 'turn.completed',
        turnId: 'turn-1',
        status: 'interrupted',
        completedAt: 5_000,
      }),
    )

    expect(view.spinners()).toHaveLength(0)
  })

  it('clears when the chat fails', () => {
    const state = steeredTurn()
    const view = renderThread(state)

    view.publish(apply(state, { type: 'thread.error', threadId: 'thread-1', message: 'Exited' }))

    expect(view.spinners()).toHaveLength(0)
  })

  it('leaves the prompt that opens a turn to the working rail', () => {
    const answered = apply(
      emptyThread,
      { type: 'item.completed', item: { ...prompt, status: 'completed' } },
      {
        type: 'item.completed',
        item: { ...reply, status: 'completed', phase: 'final_answer' },
      },
    )
    const view = renderThread(beginOptimisticTurn(answered, 'Now the pricing page', 'local:next'))

    expect(view.spinners()).toHaveLength(0)
    expect(view.container.querySelector('.thread__rail .activity--working')).toBeTruthy()
  })
})
