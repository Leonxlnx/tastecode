// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memo, useSyncExternalStore } from 'react'
import type { ApprovalDecision, DomainEvent, Item, Subagent } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'

vi.mock('../Thread.js', () => ({
  Thread: memo(
    (props: {
      frameStore: ThreadFrameStore
      threadId?: string
      onDecide: (id: string, decision: ApprovalDecision) => void
    }) => {
      const snapshot = useSyncExternalStore(
        props.frameStore.subscribe,
        props.frameStore.getSnapshot,
        props.frameStore.getSnapshot,
      )
      return (
        <div data-testid="child-thread" data-thread={props.threadId}>
          <span>{snapshot.items.map((item) => item.text).join('|')}</span>
          {snapshot.approvals.map((approval) => (
            <button key={approval.id} onClick={() => props.onDecide(approval.id, 'approve')}>
              Allow {approval.id}
            </button>
          ))}
        </div>
      )
    },
  ),
}))

import { WorkspaceAgents } from './WorkspaceAgents.js'

afterEach(() => cleanup())

const row = (id: string, subagent: Subagent): Item => ({
  id,
  turnId: 'turn',
  type: 'tool_call',
  status: 'completed',
  text: 'Task\n{}',
  createdAt: 1_000,
  subagent,
})

const message = (id: string, text: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id,
    turnId: 'child-turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 2_000,
  },
})

const reviewer = row('subagent-1', {
  id: 'a1',
  name: 'Reviewer',
  description: 'Review src/a.ts',
  state: 'running',
  threadId: 'child-1',
  provider: 'codex',
  model: 'gpt-5.5',
})
const explorer = row('native-1', {
  id: 'n1',
  name: 'Explore',
  description: 'Find the token refresh',
  state: 'completed',
  toolUses: 4,
  durationMs: 12_000,
  summary: 'The refresh lives in auth/session.ts.',
})

function setup(items: Item[]) {
  const frameStore = new ThreadFrameStore({ ...emptyThread, items })
  const transport = new TestTransport((method) => {
    switch (method) {
      case 'thread.subagents':
        return { subagents: [] }
      case 'thread.history':
        return {
          events: [
            { seq: 1, event: message('m1', 'Reading src/a.ts') },
            {
              seq: 2,
              event: {
                type: 'approval.requested',
                request: { id: 'ap1', kind: 'command', command: 'pnpm test', createdAt: 2_000 },
              },
            },
          ],
          running: true,
          approval: 'ask',
        }
      default:
        return {}
    }
  })
  render(<WorkspaceAgents active transport={transport} threadId="parent" frameStore={frameStore} />)
  return { frameStore, transport }
}

describe('a subagent opened from the Agents tab', () => {
  it('shows a TasteCode child’s own chat live, answers its approval and stops it', async () => {
    const { transport } = setup([reviewer, explorer])
    fireEvent.click(await screen.findByRole('button', { name: /Reviewer/ }))

    expect(await screen.findByText('Reading src/a.ts')).toBeTruthy()
    expect(screen.getByTestId('child-thread').dataset['thread']).toBe('child-1')
    expect(screen.getByText('Codex · gpt-5.5')).toBeTruthy()
    expect(transport.requests).toContainEqual({
      method: 'thread.history',
      params: { threadId: 'child-1' },
    })

    // Live events of this child arrive; an older seq, or another chat's, do not.
    act(() => {
      transport.emit('subagent.event', {
        threadId: 'child-1',
        parentThreadId: 'parent',
        event: message('m2', 'Found two bugs'),
        seq: 3,
      })
      transport.emit('subagent.event', {
        threadId: 'child-1',
        parentThreadId: 'parent',
        event: message('m0', 'replayed'),
        seq: 2,
      })
      transport.emit('subagent.event', {
        threadId: 'child-2',
        parentThreadId: 'parent',
        event: message('m9', 'someone else'),
        seq: 9,
      })
    })
    expect(screen.getByText('Reading src/a.ts|Found two bugs')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Allow ap1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() =>
      expect(transport.requests).toEqual(
        expect.arrayContaining([
          {
            method: 'thread.respondToApproval',
            params: { threadId: 'child-1', approvalId: 'ap1', decision: 'approve' },
          },
          { method: 'thread.interrupt', params: { threadId: 'child-1' } },
        ]),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'All subagents' }))
    expect(await screen.findByRole('region', { name: 'Running' })).toBeTruthy()
    expect(screen.queryByTestId('child-thread')).toBeNull()
  })

  it('shows an engine’s own subagent from its snapshot, without a transcript', async () => {
    const { transport } = setup([reviewer, explorer])
    fireEvent.click(await screen.findByRole('button', { name: /Explore/ }))
    expect(await screen.findByText('The refresh lives in auth/session.ts.')).toBeTruthy()
    expect(screen.getByText('Find the token refresh')).toBeTruthy()
    expect(screen.getByText('Transcript not available for this engine yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(transport.requests.some((request) => request.method === 'thread.history')).toBe(false)
  })

  it('follows the open subagent’s row as it changes', async () => {
    const { frameStore } = setup([reviewer])
    fireEvent.click(await screen.findByRole('button', { name: /Reviewer/ }))
    await screen.findByText('Reading src/a.ts')
    act(() =>
      frameStore.publish({
        ...emptyThread,
        items: [
          row('subagent-1', { ...reviewer.subagent!, state: 'completed', durationMs: 5_000 }),
        ],
      }),
    )
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})
