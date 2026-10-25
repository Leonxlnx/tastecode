// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, reduce, reduceEventLog } from '../thread-store.js'
import type { ThreadState } from '../thread-state.js'

const derive = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./brief.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./brief.js')>()
  return {
    ...actual,
    deriveBrief: (...args: Parameters<typeof actual.deriveBrief>) => {
      derive.calls += 1
      return actual.deriveBrief(...args)
    },
  }
})
// The answer's Markdown is the transcript's own renderer; plain text is enough here.
vi.mock('./Markdown.js', () => ({ Markdown: (props: { text: string }) => <p>{props.text}</p> }))

const { BRIEF_REFRESH_MS, BriefView } = await import('./BriefView.js')

const PROJECT = 'C:\\work\\payments-api'
let at = Date.UTC(2026, 9, 25, 9)
let sequence = 0
const next = () => `id-${++sequence}`

function item(turnId: string, fields: Partial<Item> & Pick<Item, 'type'>): Item {
  at += 1_000
  return { id: next(), turnId, status: 'completed', createdAt: at, ...fields }
}

function turnEvents(turnId: string, prompt: string, work: Item[], answer?: string): DomainEvent[] {
  const events: DomainEvent[] = [
    { type: 'turn.started', turn: { id: turnId, threadId: 't', status: 'running', createdAt: at } },
    { type: 'item.completed', item: item(turnId, { type: 'message', role: 'user', text: prompt }) },
  ]
  for (const each of work) {
    events.push({ type: 'item.started', item: { ...each, status: 'started' } })
    if (each.status === 'completed') events.push({ type: 'item.completed', item: each })
  }
  if (answer !== undefined) {
    events.push({
      type: 'item.completed',
      item: item(turnId, {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        text: answer,
      }),
    })
    events.push({ type: 'turn.completed', turnId, status: 'completed', completedAt: at + 500 })
  }
  return events
}

function finishedChat(): ThreadState {
  const events = [
    ...turnEvents(
      'turn-1',
      'Find the double charge.',
      [
        item('turn-1', {
          type: 'command',
          command: 'pnpm vitest run',
          exitCode: 1,
          text: 'Tests  1 failed | 9 passed',
        }),
      ],
      'The id is written after the charge.',
    ),
    ...turnEvents(
      'turn-2',
      'Fix it and cover the race.',
      [
        item('turn-2', {
          type: 'file_change',
          path: `${PROJECT}\\src\\webhooks\\handler.ts`,
          linesAdded: 18,
          linesRemoved: 5,
        }),
        item('turn-2', {
          type: 'command',
          command: 'pnpm vitest run',
          exitCode: 0,
          durationMs: 3_100,
          text: 'Tests  42 passed (42)',
        }),
      ],
      'Done: the id is inserted first.',
    ),
  ]
  return reduceEventLog(
    emptyThread,
    events.map((event, seq) => ({ seq, event })),
  )
}

function props(store: ThreadFrameStore) {
  return {
    frameStore: store,
    threadId: 't',
    title: 'Webhook double-charge on Stripe retries',
    projectPath: PROJECT,
    projectName: 'payments-api',
    branch: 'fix/webhook-idempotency',
    source: { name: 'Claude Code', mark: 'anthropic' as const, model: 'Opus 5.5', effort: 'High' },
    loading: false,
    checkpoints: [],
    toggleShortcut: 'Ctrl+I',
    onOpenReview: vi.fn(),
    onAskAbout: vi.fn(),
    onShowConversation: vi.fn(),
    onRevertCheckpoint: vi.fn(),
    onOpenRollback: vi.fn(),
  }
}

beforeEach(() => {
  derive.calls = 0
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BriefView', () => {
  it('reads a finished chat as a ledger', () => {
    render(<BriefView {...props(new ThreadFrameStore(finishedChat()))} />)

    expect(
      screen.getByRole('heading', { name: 'Webhook double-charge on Stripe retries' }),
    ).toBeTruthy()
    for (const label of ['Asked', 'Changes', 'Checks', 'Answer']) {
      expect(screen.getByRole('heading', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }
    expect(screen.getByText('Fix it and cover the race.')).toBeTruthy()
    expect(screen.getByText('42 passed')).toBeTruthy()
    expect(screen.getByText('Done: the id is inserted first.')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Turns' })).toBeTruthy()
  })

  it('opens a file in Review and asks about it without sending', () => {
    const view = props(new ThreadFrameStore(finishedChat()))
    render(<BriefView {...view} />)

    fireEvent.click(screen.getByRole('button', { name: /^src\/webhooks\/handler\.ts/ }))
    expect(view.onOpenReview).toHaveBeenCalledWith(`${PROJECT}\\src\\webhooks\\handler.ts`)

    fireEvent.click(screen.getByRole('button', { name: 'Ask about src/webhooks/handler.ts' }))
    expect(view.onAskAbout).toHaveBeenCalledWith('About src/webhooks/handler.ts: ')
  })

  it('shows the chat as it stood after an earlier turn, and Escape returns to now', () => {
    render(<BriefView {...props(new ThreadFrameStore(finishedChat()))} />)

    fireEvent.click(
      screen.getByRole('button', { name: /^Show the chat after turn 1: Find the double charge/ }),
    )
    expect(screen.getByRole('status').textContent).toContain('as it stood after turn 1')
    expect(screen.getByText('The id is written after the charge.')).toBeTruthy()
    expect(screen.queryByText('Fix it and cover the race.')).toBeNull()

    fireEvent.keyDown(screen.getByTestId('brief'), { key: 'Escape' })
    expect(screen.queryByText(/as it stood after turn 1/)).toBeNull()
    expect(screen.getByText('Fix it and cover the race.')).toBeTruthy()
  })

  it('follows a running turn at most every 500 ms and never per text delta', () => {
    vi.useFakeTimers()
    let state = reduce(finishedChat(), {
      type: 'turn.started',
      turn: { id: 'turn-3', threadId: 't', status: 'running', createdAt: at },
    })
    const store = new ThreadFrameStore(state)
    render(<BriefView {...props(store)} />)
    const initial = derive.calls

    // A streamed answer: one started message, then many text deltas.
    const reply = item('turn-3', {
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: '',
    })
    act(() => {
      state = reduce(state, { type: 'item.started', item: reply })
      store.publish(state)
    })
    const afterStructure = derive.calls
    act(() => {
      for (let index = 0; index < 200; index += 1) {
        state = reduce(state, {
          type: 'item.delta',
          turnId: 'turn-3',
          itemId: reply.id,
          textDelta: 'word ',
        })
        store.publish(state)
      }
    })
    expect(derive.calls).toBe(afterStructure)

    // Ten structural changes inside one window read once, when the window ends.
    act(() => {
      for (let index = 0; index < 10; index += 1) {
        state = reduce(state, {
          type: 'item.completed',
          item: item('turn-3', { type: 'command', command: `pnpm test ${index}`, exitCode: 0 }),
        })
        store.publish(state)
      }
    })
    act(() => {
      vi.advanceTimersByTime(BRIEF_REFRESH_MS)
    })
    expect(derive.calls - initial).toBeLessThanOrEqual(3)
    expect(document.querySelector('.brief-check__command')?.textContent).toBe('pnpm test 9')
    expect(document.querySelector('.brief-now')?.textContent).toContain('Ran')
  })
})
