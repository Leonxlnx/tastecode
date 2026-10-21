// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item, ProviderNotice } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'

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

import { providerNoticeLabel, Thread } from './Thread.js'

afterEach(cleanup)

const said = (id: string, turnId: string, role: 'user' | 'assistant', text: string): Item => ({
  id,
  turnId,
  type: 'message',
  role,
  status: 'completed',
  text,
  createdAt: 1_000,
})

describe('a chat that switched provider', () => {
  it('marks the switch between the turns as a line of its own', () => {
    const items: Item[] = [
      said('ask', 'turn-1', 'user', 'Rename the loader'),
      {
        id: 'command',
        turnId: 'turn-1',
        type: 'command',
        status: 'completed',
        command: 'rg loader',
        createdAt: 1_500,
      },
      said('answer', 'turn-1', 'assistant', 'Renamed.'),
      {
        id: 'notice-1',
        turnId: '',
        type: 'notice',
        status: 'completed',
        notice: { kind: 'provider', provider: 'claude-code', model: 'opus' },
        createdAt: 2_000,
      },
      said('next', 'turn-2', 'user', 'Now the tests'),
    ]
    const { container } = render(
      <Thread
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    const row = screen.getByRole('note')
    expect(row.textContent).toBe('Switched to Claude Code · opus')
    // Not folded into the earlier turn's work.
    expect(row.closest('.activity')).toBeNull()
    expect(container.querySelectorAll('.aux--notice')).toHaveLength(1)
  })

  it('names the agent or the provider, and the model when one was chosen', () => {
    expect(providerNoticeLabel({ kind: 'provider', provider: 'codex' })).toBe('Switched to Codex')
    expect(providerNoticeLabel({ kind: 'provider', provider: 'acp', agent: 'gemini' })).toBe(
      'Switched to gemini',
    )
  })

  it("names the account a chat moved to, once the app knows the account's name", () => {
    const moved: ProviderNotice = {
      kind: 'provider',
      provider: 'codex',
      accountId: 'team-9z8y7x',
      model: 'gpt-6.1',
    }
    expect(providerNoticeLabel(moved, (_provider, accountId) => `Team ${accountId}`)).toBe(
      'Switched to Codex (Team team-9z8y7x) · gpt-6.1',
    )
    expect(providerNoticeLabel(moved)).toBe('Switched to Codex · gpt-6.1')
  })
})
