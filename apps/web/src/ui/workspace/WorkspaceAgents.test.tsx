// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item, Subagent, ThreadSubagent } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'
import { WorkspaceAgents } from './WorkspaceAgents.js'

const listing = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./agents-list.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents-list.js')>()
  return {
    ...actual,
    subagentEntries: (items: readonly Item[]) => {
      listing.calls += 1
      return actual.subagentEntries(items)
    },
  }
})

afterEach(() => {
  cleanup()
  listing.calls = 0
})

const row = (id: string, createdAt: number, subagent: Subagent): Item => ({
  id,
  turnId: 'turn',
  type: 'tool_call',
  status: 'completed',
  text: 'Task\n{}',
  createdAt,
  subagent,
})

const native = row('native', 1_000, {
  id: 'n1',
  name: 'Explore',
  description: 'Find the token refresh',
  state: 'completed',
  toolUses: 4,
  durationMs: 12_000,
})
const nativeRunning = row('native-running', 3_000, {
  id: 'n2',
  name: 'Tester',
  description: 'Run the unit tests',
  state: 'running',
})
const listed: ThreadSubagent = {
  itemId: 'subagent-x',
  createdAt: 2_000,
  subagent: {
    id: 'a1',
    name: 'Reviewer',
    description: 'Review src/a.ts',
    state: 'running',
    threadId: 'child-1',
    provider: 'codex',
    model: 'gpt-5.5',
    attention: 'approval',
  },
}

function setup(items: Item[], subagents: ThreadSubagent[] = []) {
  const frameStore = new ThreadFrameStore({ ...emptyThread, items })
  const transport = new TestTransport((method) => {
    if (method === 'thread.subagents') return { subagents }
    throw new Error(method)
  })
  return { frameStore, transport }
}

describe('WorkspaceAgents', () => {
  it('says so when a chat has no sub-agents', async () => {
    const { frameStore, transport } = setup([])
    render(<WorkspaceAgents active transport={transport} threadId="t" frameStore={frameStore} />)
    expect(await screen.findByText('No subagents in this chat yet')).toBeTruthy()
  })

  it('lists running sub-agents above finished ones, newest first, with their engine', async () => {
    const { frameStore, transport } = setup([native, nativeRunning], [listed])
    render(<WorkspaceAgents active transport={transport} threadId="t" frameStore={frameStore} />)
    const running = await screen.findByRole('region', { name: 'Running' })
    await within(running).findByText('Reviewer')
    const names = within(running)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('.agents-row__name')?.textContent)
    expect(names).toEqual(['Tester', 'Reviewer'])
    expect(within(running).getByText('Codex · gpt-5.5 · Review src/a.ts')).toBeTruthy()
    expect(within(running).getByText('Needs approval')).toBeTruthy()
    const finished = screen.getByRole('region', { name: 'Finished' })
    expect(within(finished).getByText('Explore')).toBeTruthy()
    expect(within(finished).getByText('4 tools')).toBeTruthy()
    expect(transport.requests).toEqual([{ method: 'thread.subagents', params: { threadId: 't' } }])
  })

  it('prefers the transcript row over the listed copy of the same sub-agent', async () => {
    const finishedCopy = row(listed.itemId, listed.createdAt, {
      ...listed.subagent,
      state: 'completed',
      attention: undefined,
    })
    const { frameStore, transport } = setup([finishedCopy], [listed])
    render(<WorkspaceAgents active transport={transport} threadId="t" frameStore={frameStore} />)
    const finished = await screen.findByRole('region', { name: 'Finished' })
    expect(within(finished).getByText('Reviewer')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull()
  })

  it('neither asks nor follows the transcript while hidden', () => {
    const { frameStore, transport } = setup([native])
    render(
      <WorkspaceAgents active={false} transport={transport} threadId="t" frameStore={frameStore} />,
    )
    const calls = listing.calls
    act(() => frameStore.publish({ ...emptyThread, items: [native, nativeRunning] }))
    expect(listing.calls).toBe(calls)
    expect(transport.requests).toEqual([])
  })

  it('does not rescan the transcript for a streamed delta', async () => {
    const { frameStore, transport } = setup([native])
    render(<WorkspaceAgents active transport={transport} threadId="t" frameStore={frameStore} />)
    await screen.findByText('Explore')
    const calls = listing.calls
    const current = frameStore.getSnapshot()
    // A delta changes the live overlay only; the structural items stay the same array.
    act(() =>
      frameStore.publish({
        ...current,
        liveItems: new Map([
          [
            0,
            {
              item: { ...native, text: 'more' },
              version: 1,
              textUpdate: { kind: 'append', text: 'more' },
            },
          ],
        ]),
      }),
    )
    expect(listing.calls).toBe(calls)
  })
})
