// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, type ThreadState } from '../thread-store.js'

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

const prompt: Item = {
  id: 'prompt',
  turnId: 'turn-1',
  type: 'message',
  role: 'user',
  status: 'completed',
  text: 'Check this',
  createdAt: 1_000,
}
const answer: Item = {
  ...prompt,
  id: 'answer',
  role: 'assistant',
  phase: 'final_answer',
  text: 'The result',
  createdAt: 4_000,
}

function renderTurn(items: Item[], timing: ThreadState['turnTiming'][string]) {
  return render(
    <Thread
      frameStore={new ThreadFrameStore({ ...emptyThread, items, turnTiming: { 'turn-1': timing } })}
      onDecide={() => undefined}
      onAnswerUserInput={() => undefined}
    />,
  )
}

// A summary without the 18px icon box starts on its label, so it needs its
// own offset to land on the reply text edge.
describe('activity summary text edge', () => {
  it('marks the duration of a turn without work as a bare row', () => {
    const { container } = renderTurn([prompt, answer], { startedAt: 1_000, completedAt: 4_000 })

    const summary = container.querySelector('.activity--duration .activity__summary')!
    expect(summary.textContent).toBe('Worked for 3s')
    expect(summary.classList.contains('activity__summary--bare')).toBe(true)
    expect(summary.querySelector('.activity__glyph')).toBeNull()
  })

  it('marks a completed work summary as a bare row', () => {
    const note: Item = {
      ...answer,
      id: 'note',
      phase: 'commentary',
      text: 'Checking.',
      createdAt: 2_000,
    }
    const command: Item = {
      id: 'cmd',
      turnId: 'turn-1',
      type: 'command',
      status: 'completed',
      command: 'pwd',
      createdAt: 3_000,
    }
    renderTurn([prompt, note, command, answer], { startedAt: 1_000, completedAt: 4_000 })

    const summary = screen.getByRole('button', { name: 'Worked for 3s' })
    expect(summary.classList.contains('activity__summary--bare')).toBe(true)
    expect(summary.querySelector('.activity__glyph')).toBeNull()
  })

  it('keeps the icon offset on a summary that shows an icon', () => {
    const command: Item = {
      id: 'cmd',
      turnId: 'turn-1',
      type: 'command',
      status: 'completed',
      command: 'pnpm test',
      createdAt: 2_000,
    }
    renderTurn([prompt, command, { ...answer, status: 'started' }], {
      startedAt: 1_000,
      completedAt: 5_000,
      interrupted: true,
    })

    const summary = screen.getByRole('button', { name: 'Stopped after 4s' })
    expect(summary.querySelector('.activity__glyph svg')).toBeTruthy()
    expect(summary.classList.contains('activity__summary--bare')).toBe(false)
  })
})
