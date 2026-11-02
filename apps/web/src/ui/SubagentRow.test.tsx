// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Item, Subagent } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import { SubagentRow, subagentClockRunning } from './SubagentRow.js'
import { Thread } from './Thread.js'

vi.mock('../bridge.js', () => ({
  canPreviewViewedImages: false,
  knownViewedImagePreview: () => undefined,
  previewViewedImage: async () => undefined,
  revealPath: async () => undefined,
  writeClipboardText: async () => undefined,
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 72 })),
    getTotalSize: () => count * 72,
    measureElement: () => undefined,
    indexFromElement: (node: Element) => Number(node.getAttribute('data-index')),
    resizeItem: () => undefined,
    measurementsCache: [],
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = 1_800_000_000_000

function spawn(id: string, subagent: Partial<Subagent>, fields: Partial<Item> = {}): Item {
  return {
    id,
    turnId: 'turn-1',
    type: 'tool_call',
    status: subagent.state === 'running' && !subagent.background ? 'started' : 'completed',
    text: `Agent\n${JSON.stringify({ description: subagent.description, prompt: `Please ${id}` })}`,
    createdAt: NOW - 5_000,
    subagent: { id, state: 'running', ...subagent },
    ...fields,
  }
}

/** The figures a row shows, without the dots CSS draws between them. */
function parts(root: Element): string[] {
  return [...root.querySelectorAll('.subagent__part')].map((node) => node.textContent ?? '')
}

function message(id: string, createdAt: number, fields: Partial<Item>): Item {
  return { id, turnId: 'turn-1', type: 'message', status: 'completed', createdAt, ...fields }
}

describe('SubagentRow', () => {
  it('shows a running subagent with its counters and a live clock', () => {
    vi.useFakeTimers({ now: NOW })
    const { container } = render(
      <SubagentRow
        item={spawn('explore', {
          name: 'Explore',
          description: 'Find the token refresh',
          toolUses: 3,
          tokens: 12_400,
        })}
      />,
    )

    expect(container.querySelector('.subagent__name')?.textContent).toBe('Explore')
    expect(container.querySelector('.subagent__task')?.textContent).toBe('Find the token refresh')
    const status = () => parts(container)
    expect(status()).toEqual(['Running', '3 tools', '12.4k tokens', '5s'])
    expect(subagentClockRunning()).toBe(true)

    act(() => vi.advanceTimersByTime(2_000))
    expect(status()).toEqual(['Running', '3 tools', '12.4k tokens', '7s'])
  })

  it('stops the shared clock once no running subagent is on screen', () => {
    vi.useFakeTimers({ now: NOW })
    const running = spawn('a', { name: 'Explore' })
    const view = render(<SubagentRow item={running} />)
    expect(subagentClockRunning()).toBe(true)

    view.rerender(
      <SubagentRow
        item={{ ...running, status: 'completed', subagent: { id: 'a', state: 'completed' } }}
      />,
    )
    expect(subagentClockRunning()).toBe(false)

    view.rerender(<SubagentRow item={running} />)
    expect(subagentClockRunning()).toBe(true)
    view.unmount()
    expect(subagentClockRunning()).toBe(false)
  })

  it('shows a finished subagent by its figures and opens to its task and result', () => {
    const { container } = render(
      <SubagentRow
        item={spawn('reviewer', {
          name: 'general-purpose',
          description: 'Read notes',
          state: 'completed',
          toolUses: 1,
          durationMs: 64_000,
          summary: 'Tiny scratch project for a subagent capture.',
        })}
      />,
    )

    expect(parts(container)).toEqual(['1 tool', '1m 4s'])
    expect(container.querySelector('.subagent__pulse')).toBeNull()
    expect(subagentClockRunning()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /general-purpose/ }))
    const detail = container.querySelector('.subagent__detail')
    expect(detail?.querySelector('dd')?.textContent).toBe('Please reviewer')
    expect(detail?.querySelector('.tool-detail__output')?.textContent).toBe(
      'Tiny scratch project for a subagent capture.',
    )
  })

  it('says when a subagent failed or was stopped, and marks background runs', () => {
    const { container } = render(
      <>
        <SubagentRow
          item={spawn(
            'failed',
            { state: 'failed', summary: 'User cancelled' },
            { status: 'failed' },
          )}
        />
        <SubagentRow item={spawn('stopped', { state: 'interrupted', toolUses: 2 })} />
        <SubagentRow item={spawn('later', { name: 'Explore', background: true })} />
      </>,
    )

    const rows = [...container.querySelectorAll('.aux--subagent')]
    expect(rows.map((row) => row.querySelector('.subagent__name')?.textContent)).toEqual([
      'Subagent',
      'Subagent',
      'Explore',
    ])
    expect(rows[0]?.getAttribute('data-failed')).toBe('true')
    expect(rows[0]?.querySelector('.subagent__state.is-failed')?.textContent).toBe('Failed')
    expect(parts(rows[1]!)).toEqual(['Stopped', '2 tools'])
    expect(rows[2]?.querySelector('.subagent__tag')?.textContent).toBe('Background')
    expect(rows[0]?.querySelector('.subagent__tag')).toBeNull()
  })

  it('renders nothing for a call without a subagent', () => {
    const { container } = render(
      <SubagentRow item={{ ...spawn('plain', {}), subagent: undefined }} />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('subagents in the transcript', () => {
  function renderThread(items: Item[], running = false) {
    return render(
      <Thread
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items,
            ...(running ? { running: true, activeTurn: { id: 'turn-1', startedAt: 1 } } : {}),
          })
        }
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
  }

  it('names the running subagents in the live work summary and lists each of them', () => {
    const { container } = renderThread(
      [
        message('prompt', 1, { role: 'user', text: 'Look around' }),
        spawn('one', { name: 'Explore', description: 'Count files' }, { createdAt: 2 }),
        spawn('two', { name: 'Explore', description: 'Read notes' }, { createdAt: 3 }),
      ],
      true,
    )

    const summary = container.querySelector<HTMLButtonElement>('.activity__summary')!
    expect(summary.textContent).toBe('Running 2 subagents')
    fireEvent.click(summary)
    // Subagents that are all the work need no header of their own.
    expect(container.querySelector('.activity--subagents')).toBeNull()
    expect(
      [...container.querySelectorAll('.activity__body .subagent__task')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Count files', 'Read notes'])
  })

  it('keeps naming the subagents while the main agent waits on them in another call', () => {
    const { container } = renderThread(
      [
        message('prompt', 1, { role: 'user', text: 'Look around' }),
        spawn('one', { name: 'map_webhooks' }, { createdAt: 2, status: 'completed' }),
        spawn('two', { name: 'read_notes' }, { createdAt: 3, status: 'completed' }),
        message('wait', 4, { type: 'tool_call', status: 'started', text: 'Waiting for subagents' }),
      ],
      true,
    )
    expect(container.querySelector('.activity__summary')?.textContent).toBe('Running 2 subagents')
  })

  it('leaves the summary to the main agent while only background subagents run', () => {
    const { container } = renderThread(
      [
        message('prompt', 1, { role: 'user', text: 'Look around' }),
        spawn('later', { name: 'Explore', background: true }, { createdAt: 2 }),
        message('cmd', 3, { type: 'command', status: 'started', command: 'pnpm test' }),
      ],
      true,
    )
    expect(container.querySelector('.activity__summary')?.textContent).toBe('Running pnpm test')
  })

  it('names a single running subagent by its task', () => {
    const { container } = renderThread(
      [
        message('prompt', 1, { role: 'user', text: 'Look around' }),
        spawn('one', { name: 'Explore', description: 'Count files' }, { createdAt: 2 }),
      ],
      true,
    )
    expect(container.querySelector('.activity__summary')?.textContent).toBe(
      'Running Explore · Count files',
    )
  })

  it('gathers subagents started together under one header among other work', () => {
    const { container } = renderThread([
      message('prompt', 1, { role: 'user', text: 'Look around' }),
      spawn('one', { state: 'completed', durationMs: 2_000 }, { createdAt: 2 }),
      spawn('two', { state: 'failed' }, { createdAt: 3, status: 'failed' }),
      { ...message('thought', 4, {}), type: 'reasoning', text: 'Checking what they found.' },
      { ...message('cmd', 4, {}), type: 'command', command: 'ls' },
      { ...message('cmd-2', 5, {}), type: 'command', command: 'pwd' },
      message('answer', 6, { role: 'assistant', phase: 'final_answer', text: 'Done.' }),
    ])

    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    const group = container.querySelector('.activity--subagents')
    expect(group?.querySelector('.activity__label')?.textContent).toBe('2 subagents · 1 failed')
    expect(container.querySelector('.activity--batch:not(.activity--subagents)')).not.toBeNull()

    fireEvent.click(group!.querySelector<HTMLButtonElement>('.activity__summary')!)
    expect(group?.querySelectorAll('.aux--subagent')).toHaveLength(2)
  })

  it('keeps a background subagent that outlives its turn in the summary', () => {
    renderThread([
      message('prompt', 1, { role: 'user', text: 'Look around' }),
      spawn('later', { name: 'Explore', background: true }, { createdAt: 2 }),
      message('answer', 3_000, { role: 'assistant', phase: 'final_answer', text: 'Started it.' }),
    ])
    expect(screen.getByRole('button', { name: /Worked for 3s · 1 subagent running/ })).toBeDefined()
  })
})
