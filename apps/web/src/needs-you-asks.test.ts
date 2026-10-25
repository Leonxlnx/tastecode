import { describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item, UserInputRequest } from '@harness/contracts'
import {
  askFromState,
  askLine,
  MAX_ASK_TARGETS,
  NeedsYouAsks,
  questionAnswerable,
  statusAfterRequest,
  type NeedsYouAskSource,
  type NeedsYouAskTarget,
} from './needs-you-asks.js'
import { emptyThread, type ThreadState } from './thread-state.js'
import { reduceEventLog } from './thread-store.js'

const page = (...events: DomainEvent[]) => events.map((event, index) => ({ seq: index + 1, event }))
const state = (...events: DomainEvent[]): ThreadState =>
  reduceEventLog(emptyThread, page(...events))

const turn = (id = 'turn-1'): DomainEvent => ({
  type: 'turn.started',
  turn: { id, threadId: 'thread-1', status: 'running', createdAt: 1 },
})
const approval = (id = 'approval-1', command = 'pnpm add zod@4.1.2'): DomainEvent => ({
  type: 'approval.requested',
  request: {
    id,
    kind: 'command',
    command,
    cwd: 'E:\\work\\billing-service',
    reason: 'Install it',
    createdAt: 2,
  },
})
const question = (overrides: Partial<UserInputRequest['questions'][number]> = {}): DomainEvent => ({
  type: 'user_input.requested',
  request: {
    id: 'input-1',
    turnId: 'turn-1',
    questions: [
      {
        id: 'rounding',
        header: 'Rounding',
        question: 'Which currency rounding do we keep?',
        allowOther: true,
        secret: false,
        options: [
          { label: "Banker's rounding", description: 'Round halves to even' },
          { label: 'Half-up', description: 'Round halves away from zero' },
        ],
        ...overrides,
      },
    ],
    autoResolutionMs: null,
    createdAt: 3,
  },
})
const item = (fields: Partial<Item> & Pick<Item, 'id' | 'type'>): DomainEvent => ({
  type: 'item.completed',
  item: { turnId: 'turn-1', status: 'completed', createdAt: 4, ...fields },
})

describe('reading what a chat asks from its newest page', () => {
  it('finds the open approval with its exact command and folder', () => {
    const ask = askFromState(state(turn(), approval()), 'approval')
    expect(ask).toMatchObject({
      kind: 'approval',
      more: 0,
      request: { command: 'pnpm add zod@4.1.2', cwd: 'E:\\work\\billing-service' },
    })
    expect(askLine({ status: 'ready', ask }, 'approval')).toEqual({
      verb: 'Approve',
      object: 'pnpm add zod@4.1.2',
      code: true,
    })
  })

  it('counts further approvals and keeps the oldest first', () => {
    const ask = askFromState(
      state(turn(), approval('a1', 'one'), approval('a2', 'two')),
      'approval',
    )
    expect(ask).toMatchObject({ kind: 'approval', more: 1, request: { id: 'a1' } })
  })

  it('reports an approval that has a matching resolved event as already answered', () => {
    const resolved = state(turn(), approval(), { type: 'approval.resolved', id: 'approval-1' })
    expect(askFromState(resolved, 'approval')).toEqual({ kind: 'answered' })
    expect(askLine({ status: 'ready', ask: { kind: 'answered' } }, 'approval').verb).toBe(
      'Already answered',
    )
  })

  it('drops an approval its turn ended without, as the transcript does', () => {
    const ended: DomainEvent = { type: 'turn.completed', turnId: 'turn-1', status: 'completed' }
    expect(askFromState(state(turn(), approval(), ended), 'approval')).toEqual({ kind: 'answered' })
  })

  it('finds the open question and its options', () => {
    const ask = askFromState(state(turn(), question()), 'input')
    expect(ask).toMatchObject({ kind: 'question', request: { id: 'input-1' } })
    expect(askLine({ status: 'ready', ask }, 'input')).toEqual({
      verb: 'Answer',
      object: 'Which currency rounding do we keep?',
    })
    const answered = state(turn(), question(), { type: 'user_input.resolved', id: 'input-1' })
    expect(askFromState(answered, 'input')).toEqual({ kind: 'answered' })
  })

  it('answers only questions it can show in full: never a secret or a multiple choice', () => {
    const open = (overrides: Partial<UserInputRequest['questions'][number]>) => {
      const ask = askFromState(state(turn(), question(overrides)), 'input')
      if (ask.kind !== 'question') throw new Error('expected a question')
      return questionAnswerable(ask.request)
    }
    expect(open({})).toBe(true)
    expect(open({ secret: true })).toBe(false)
    expect(open({ multiSelect: true })).toBe(false)
  })

  it('names the failed command of the last turn with the end of its output', () => {
    const failed = state(
      turn(),
      item({ id: 'u1', type: 'message', role: 'user', text: 'Run the export suite' }),
      item({
        id: 'c1',
        type: 'command',
        command: 'pnpm vitest run e2e/export.spec.ts',
        exitCode: 1,
        text: ' FAIL  e2e/export.spec.ts\nAssertionError: expected 2 decimals, got 3\n\n Tests  3 failed | 41 passed\n',
      }),
      { type: 'turn.completed', turnId: 'turn-1', status: 'failed' },
    )
    const ask = askFromState(failed, 'failed')
    expect(ask).toEqual({
      kind: 'failure',
      message: undefined,
      model: undefined,
      command: {
        command: 'pnpm vitest run e2e/export.spec.ts',
        exitCode: 1,
        tail: [
          ' FAIL  e2e/export.spec.ts',
          'AssertionError: expected 2 decimals, got 3',
          ' Tests  3 failed | 41 passed',
        ],
      },
    })
    expect(askLine({ status: 'ready', ask }, 'failed')).toEqual({
      verb: 'Failed',
      object: 'pnpm vitest run e2e/export.spec.ts',
      code: true,
    })
  })

  it('ignores a failed command from an earlier turn', () => {
    const earlier = state(
      turn('t0'),
      item({ id: 'c0', turnId: 't0', type: 'command', command: 'pnpm lint', exitCode: 2 }),
      { type: 'turn.completed', turnId: 't0', status: 'completed' },
      turn(),
      item({ id: 'u1', type: 'message', role: 'user', text: 'Try again' }),
      { type: 'thread.error', threadId: 'thread-1', message: 'The agent stopped: rate limited' },
    )
    expect(askFromState(earlier, 'failed')).toMatchObject({
      kind: 'failure',
      command: undefined,
      message: 'The agent stopped: rate limited',
    })
  })

  it('keeps a direct API chat honest: no approval events means nothing to approve', () => {
    const api = state(turn(), item({ id: 'm1', type: 'message', role: 'assistant', text: 'Hi' }))
    expect(askFromState(api, 'approval')).toEqual({ kind: 'answered' })
    expect(askFromState(api, 'failed')).toEqual({
      kind: 'failure',
      message: undefined,
      command: undefined,
      model: undefined,
    })
  })

  it('says only what the band knows while it reads', () => {
    expect(askLine(undefined, 'approval').verb).toBe('Waiting for approval')
    expect(askLine({ status: 'loading' }, 'input').verb).toBe('Reading…')
    expect(askLine({ status: 'error', message: 'offline' }, 'failed').verb).toBe('Failed')
  })
})

function source(overrides: Partial<NeedsYouAskSource> = {}) {
  const reads: string[] = []
  const live = new Map<string, ThreadState>()
  const pages = new Map<string, DomainEvent[]>()
  const value: NeedsYouAskSource = {
    live: (id) => live.get(id),
    readNewest: (id) => {
      reads.push(id)
      return Promise.resolve(page(...(pages.get(id) ?? [])))
    },
    ...overrides,
  }
  return { value, reads, live, pages }
}

const target = (id: string, attention: NeedsYouAskTarget['attention'], since = 1) => ({
  id,
  attention,
  since,
})

describe('the status a chat has after its request is answered', () => {
  const resolved: DomainEvent = { type: 'approval.resolved', id: 'approval-1' }
  it('keeps a chat this window never loaded working, since its turn still runs', () => {
    expect(statusAfterRequest('approval', 'idle', resolved)).toBe('working')
    expect(
      statusAfterRequest('input', 'idle', { type: 'user_input.resolved', id: 'input-1' }),
    ).toBe('working')
  })

  it('leaves every other change as the chat reported it', () => {
    expect(statusAfterRequest('approval', 'approval', resolved)).toBe('approval')
    expect(statusAfterRequest('working', 'idle', resolved)).toBe('idle')
    const ended: DomainEvent = { type: 'turn.completed', turnId: 't', status: 'completed' }
    expect(statusAfterRequest('approval', 'idle', ended)).toBe('idle')
  })
})

describe('the band ask cache', () => {
  it('reads the newest page only for approvals and questions, never for a failure', async () => {
    const fake = source()
    fake.pages.set('approval', [turn(), approval()])
    const asks = new NeedsYouAsks(fake.value)
    asks.sync([target('approval', 'approval'), target('failed', 'failed')])
    expect(asks.get('approval')).toEqual({ status: 'loading' })
    // Reading a chat's history marks it read on the server, which would clear a failure.
    expect(asks.get('failed')).toEqual({ status: 'ready', ask: { kind: 'failure' } })
    await vi.waitFor(() => expect(asks.get('approval')?.status).toBe('ready'))
    expect(fake.reads).toEqual(['approval'])
  })

  it('uses the open state of a chat it already holds instead of reading', () => {
    const fake = source()
    fake.live.set('question', state(turn(), question()))
    const asks = new NeedsYouAsks(fake.value)
    asks.sync([target('question', 'input')])
    expect(asks.get('question')).toMatchObject({ status: 'ready', ask: { kind: 'question' } })
    expect(fake.reads).toEqual([])
  })

  it('keeps what a chat asked from its own event after the renderer dropped its transcript', () => {
    const fake = source()
    const asks = new NeedsYouAsks(fake.value)
    const failed = state(
      turn(),
      item({ id: 'c1', type: 'command', command: 'pnpm test', exitCode: 1, text: 'boom' }),
    )
    asks.capture('failed', failed, 'failed')
    asks.sync([target('failed', 'failed')])
    expect(asks.get('failed')).toMatchObject({
      status: 'ready',
      ask: { kind: 'failure', command: { command: 'pnpm test', exitCode: 1 } },
    })
    // Moving on forgets it.
    asks.capture('failed', failed, undefined)
    asks.sync([target('failed', 'failed', 2)])
    expect(asks.get('failed')).toEqual({ status: 'ready', ask: { kind: 'failure' } })
  })

  it('reads again only when the status changed, and only for the first rows', async () => {
    const fake = source()
    const asks = new NeedsYouAsks(fake.value)
    const many = Array.from({ length: MAX_ASK_TARGETS + 3 }, (_, index) =>
      target(`chat-${index}`, 'approval'),
    )
    asks.sync(many)
    asks.sync(many)
    await Promise.resolve()
    expect(fake.reads).toHaveLength(MAX_ASK_TARGETS + 1)
    asks.sync([target('chat-0', 'approval', 2)])
    expect(fake.reads.filter((id) => id === 'chat-0')).toHaveLength(2)
    expect(asks.get('chat-1')).toBeUndefined()
  })

  it('lets a newer status own the row when an older read answers late', async () => {
    let finish: (events: ReturnType<typeof page>) => void = () => undefined
    const slow = source({
      readNewest: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const asks = new NeedsYouAsks(slow.value)
    asks.sync([target('chat', 'approval', 1)])
    const first = finish
    slow.live.set('chat', state(turn(), question()))
    asks.sync([target('chat', 'input', 2)])
    first(page(turn(), approval()))
    await Promise.resolve()
    expect(asks.get('chat')).toMatchObject({ status: 'ready', ask: { kind: 'question' } })
  })

  it('shows a failed read, and a quiet check keeps the row as it was', async () => {
    const fake = source({ readNewest: () => Promise.reject(new Error('socket closed')) })
    const asks = new NeedsYouAsks(fake.value)
    asks.sync([target('chat', 'approval')])
    await vi.waitFor(() =>
      expect(asks.get('chat')).toEqual({ status: 'error', message: 'socket closed' }),
    )
    const checking = asks.refresh(target('chat', 'approval'), true)
    expect(asks.get('chat')).toEqual({ status: 'error', message: 'socket closed' })
    await expect(checking).resolves.toEqual({ status: 'error', message: 'socket closed' })
  })

  it('records an answer sent from the peek', () => {
    const fake = source()
    fake.live.set('chat', state(turn(), approval()))
    const asks = new NeedsYouAsks(fake.value)
    const listener = vi.fn()
    asks.subscribe(listener)
    asks.sync([target('chat', 'approval')])
    asks.settle('chat', 'Allowed once')
    expect(asks.get('chat')).toEqual({
      status: 'ready',
      ask: { kind: 'answered', reply: 'Allowed once' },
    })
    expect(askLine(asks.get('chat'), 'approval').verb).toBe('Allowed once')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
