// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { Item } from '@harness/contracts'

const markdownRender = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * 72,
      end: (index + 1) * 72,
      size: 72,
      lane: 0,
    }))
    return {
      getVirtualItems: () => rows,
      getTotalSize: () => count * 72,
      getOffsetForIndex: (index: number) => [index * 72],
      getScrollElement: () => null,
      scrollToIndex: () => undefined,
      measureElement: () => undefined,
      measurementsCache: rows,
    }
  },
}))

vi.mock('./Markdown.js', () => ({
  Markdown: ({ text, streaming = false }: { text: string; streaming?: boolean }) => {
    markdownRender({ text, streaming })
    return <span>{text}</span>
  },
}))

import { Thread } from './Thread.js'

const onDecide = () => undefined
const onAnswerUserInput = () => undefined
const onEditMessage = () => undefined
const onRevertCheckpoint = () => undefined

function message(overrides: Partial<Item>): Item {
  return {
    id: 'item',
    turnId: 'turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: '',
    createdAt: 0,
    ...overrides,
  }
}

function view(items: Item[], running = true) {
  return (
    <Thread
      items={items}
      running={running}
      activeTurn={running ? { id: 'turn-2', startedAt: 0 } : undefined}
      plan={[]}
      diff={undefined}
      approvals={[]}
      userInputs={[]}
      reviews={[]}
      checkpoints={[]}
      onDecide={onDecide}
      onAnswerUserInput={onAnswerUserInput}
      onEditMessage={onEditMessage}
      onRevertCheckpoint={onRevertCheckpoint}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  markdownRender.mockReset()
})

describe('streamed thread renders', () => {
  it('rerenders only the live Markdown row when the answer text grows', () => {
    const items: Item[] = [
      message({ id: 'user-1', turnId: 'turn-1', role: 'user', text: 'Question' }),
      message({ id: 'answer-1', turnId: 'turn-1', text: 'Done' }),
      message({ id: 'user-2', turnId: 'turn-2', role: 'user', text: 'Next question' }),
      message({ id: 'answer-2', turnId: 'turn-2', status: 'started', text: 'Hel' }),
    ]
    const rendered = render(view(items))
    const initialRenders = markdownRender.mock.calls.length

    rendered.rerender(view([...items.slice(0, -1), { ...items.at(-1)!, text: 'Hello' }]))

    expect(initialRenders).toBe(2)
    expect(markdownRender).toHaveBeenCalledTimes(initialRenders + 1)
    expect(markdownRender).toHaveBeenLastCalledWith({ text: 'Hello', streaming: true })
  })

  it('does not restart the entry animation timer for streamed text updates', () => {
    vi.useFakeTimers()
    const existing: Item[] = [
      message({ id: 'user-1', turnId: 'turn-1', role: 'user', text: 'Question' }),
      message({ id: 'answer-1', turnId: 'turn-1', text: 'Done' }),
    ]
    const rendered = render(view(existing, false))
    const live = message({
      id: 'answer-2',
      turnId: 'turn-2',
      status: 'started',
      text: 'Hel',
    })

    rendered.rerender(view([...existing, live]))
    expect(rendered.container.querySelector('[data-index="2"]')?.className).toContain('is-entering')

    act(() => vi.advanceTimersByTime(200))
    rendered.rerender(view([...existing, { ...live, text: 'Hello' }]))
    act(() => vi.advanceTimersByTime(161))

    expect(rendered.container.querySelector('[data-index="2"]')?.className).not.toContain(
      'is-entering',
    )
  })
})
