import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import {
  appendUserMessage,
  beginOptimisticTurn,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
} from './thread-store.js'
import { presentTurns } from './ui/turns.js'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  turnId: 't1',
  type: 'message',
  role: 'assistant',
  status: 'started',
  createdAt: 0,
  ...over,
})

const apply = (events: DomainEvent[]) => events.reduce(reduce, emptyThread)

afterEach(() => vi.unstubAllGlobals())

describe('thread reducer', () => {
  it('holds generated questions until their exact request is answered', () => {
    const request = {
      id: 'brief-1',
      turnId: 't1',
      questions: [
        {
          id: 'palette',
          header: 'Colour',
          question: 'Do you already have a palette?',
          allowOther: true,
          secret: false,
          options: [{ label: 'Decide for me', description: 'Infer it from the brief.' }],
        },
      ],
      autoResolutionMs: null,
      createdAt: 1,
    }
    const waiting = reduce(emptyThread, { type: 'user_input.requested', request })
    const completed = reduce(waiting, {
      type: 'turn.completed',
      turnId: request.turnId,
      status: 'completed',
    })
    const resolved = reduce(completed, { type: 'user_input.resolved', id: request.id })

    expect(waiting.userInputs).toEqual([request])
    expect(completed.userInputs).toEqual([request])
    expect(resolved.userInputs).toEqual([])
  })

  it('appends streamed text to the item being written', () => {
    const state = apply([
      { type: 'item.started', item: item({ text: '' }) },
      { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'hel' },
      { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'lo' },
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]?.text).toBe('hello')
  })

  it('folds a frame of interleaved deltas to the same state as replay', () => {
    const started = apply([
      { type: 'item.started', item: item({ id: 'i1', text: 'one' }) },
      { type: 'item.started', item: item({ id: 'i2', text: 'two' }) },
    ])
    const deltas: DomainEvent[] = [
      { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: ' A' },
      { type: 'item.delta', turnId: 't1', itemId: 'i2', textDelta: ' B' },
      { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: ' C' },
    ]
    const replayed = deltas.reduce(reduce, started)
    const batched = reduceDeltas(
      started,
      deltas.filter((event) => event.type === 'item.delta'),
    )

    expect(batched).toEqual(replayed)
  })

  it('coalesces early deltas into one placeholder per missing item', () => {
    const state = reduceDeltas(emptyThread, [
      { type: 'item.delta', turnId: 't1', itemId: 'x', textDelta: 'Hel' },
      { type: 'item.delta', turnId: 't1', itemId: 'y', textDelta: 'Other' },
      { type: 'item.delta', turnId: 't1', itemId: 'x', textDelta: 'lo' },
    ])

    expect(state.items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'x', text: 'Hello' },
      { id: 'y', text: 'Other' },
    ])
  })

  it('completes an item in place rather than appending a second copy', () => {
    const state = apply([
      { type: 'item.started', item: item({ text: '' }) },
      { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'ok.' },
      { type: 'item.completed', item: item({ status: 'completed', text: 'ok.' }) },
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]?.status).toBe('completed')
  })

  it('keeps streamed text when the completed payload carries none', () => {
    const state = apply([
      { type: 'item.started', item: item({ text: '' }) },
      { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'streamed' },
      { type: 'item.completed', item: item({ status: 'completed' }) },
    ])
    expect(state.items[0]?.text).toBe('streamed')
  })

  it('replaces the optimistic user message with the agent’s canonical one', () => {
    // Regression: the user's message rendered twice, once from the local echo
    // and once from the item the agent reports back.
    const echoed = appendUserMessage(emptyThread, 'do the thing')
    const state = reduce(echoed, {
      type: 'item.started',
      item: item({ id: 'server-1', role: 'user', text: 'do the thing' }),
    })
    expect(state.items).toHaveLength(1)
    expect(state.items[0]?.id).toBe('server-1')
  })

  it('keeps later optimistic prompts when the first canonical message arrives', () => {
    const echoed = appendUserMessage(
      appendUserMessage(emptyThread, 'first prompt'),
      'second prompt',
    )
    const state = reduce(echoed, {
      type: 'item.started',
      item: item({ id: 'server-1', role: 'user', text: 'first prompt' }),
    })

    expect(state.items.map((entry) => entry.text)).toEqual(['first prompt', 'second prompt'])
  })

  it('echoes a message when randomUUID is unavailable in an insecure mobile context', () => {
    vi.stubGlobal('crypto', {})

    const first = appendUserMessage(emptyThread, 'sent from mobile')
    const second = appendUserMessage(first, 'sent again')

    expect(second.items.map((entry) => entry.text)).toEqual(['sent from mobile', 'sent again'])
    expect(second.items[0]?.id).toMatch(/^local:/)
    expect(second.items[1]?.id).not.toBe(second.items[0]?.id)
  })

  it('starts working locally before the server confirms a turn', () => {
    const state = beginOptimisticTurn(emptyThread, 'resume this chat')

    expect(state.items[0]?.text).toBe('resume this chat')
    expect(state.running).toBe(true)
    expect(state.activeTurn?.id).toMatch(/^local-turn:/)
  })

  it('reconciles a provisional local timer to the durable server boundary', () => {
    const optimistic = beginOptimisticTurn(emptyThread, 'resume this chat')
    const acceptedAt = Date.now() + 5_000
    const confirmed = reduce(optimistic, {
      type: 'turn.started',
      turn: {
        id: 'server-turn',
        threadId: 'thread-1',
        status: 'running',
        createdAt: acceptedAt,
      },
    })

    expect(confirmed.activeTurn).toEqual({
      id: 'server-turn',
      startedAt: acceptedAt,
    })
    expect(confirmed.turnTiming['server-turn']?.startedAt).toBe(acceptedAt)
  })

  it('does not restart the timer when the same turn-start event is replayed', () => {
    const started = reduce(emptyThread, {
      type: 'turn.started',
      turn: { id: 'server-turn', threadId: 'thread-1', status: 'running', createdAt: 10 },
    })
    const replayed = reduce(started, {
      type: 'turn.started',
      turn: { id: 'server-turn', threadId: 'thread-1', status: 'running', createdAt: 40 },
    })

    expect(replayed.activeTurn?.startedAt).toBe(10)
    expect(replayed.turnTiming['server-turn']?.startedAt).toBe(10)
  })

  it('projects the same elapsed time live and after replay', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const optimistic = beginOptimisticTurn(emptyThread, 'resume this chat')
    now.mockRestore()
    const events: DomainEvent[] = [
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 5_000 },
      },
      {
        type: 'item.started',
        item: item({ id: 'user', role: 'user', text: 'resume this chat', createdAt: 5_000 }),
      },
      {
        type: 'item.completed',
        item: item({ id: 'answer', status: 'completed', text: 'Done.', createdAt: 8_000 }),
      },
      { type: 'turn.completed', turnId: 't1', status: 'completed', completedAt: 8_000 },
    ]

    const live = events.reduce(reduce, optimistic)
    const replayed = reduceEventLog(
      emptyThread,
      events.map((event, index) => ({ seq: index + 1, event })),
    )

    expect(live.turnTiming).toEqual(replayed.turnTiming)
    expect(presentTurns(live.items, live.turnTiming).get('t1')?.elapsedMs).toBe(3_000)
    expect(presentTurns(replayed.items, replayed.turnTiming).get('t1')?.elapsedMs).toBe(3_000)
  })

  it('rebuilds a whole conversation from a stored event log', () => {
    // What reopening a session does: the server hands back everything that
    // happened, and replaying it has to produce the same thread the user left.
    const state = apply([
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 0 },
      },
      { type: 'item.completed', item: item({ id: 'u1', role: 'user', text: 'run the tests' }) },
      { type: 'item.started', item: item({ id: 'a1', text: '' }) },
      { type: 'item.delta', turnId: 't1', itemId: 'a1', textDelta: 'All ' },
      { type: 'item.delta', turnId: 't1', itemId: 'a1', textDelta: 'green.' },
      {
        type: 'item.completed',
        item: item({ id: 'a1', status: 'completed', text: 'All green.' }),
      },
      { type: 'turn.completed', turnId: 't1', status: 'completed' },
    ])

    expect(state.items.map((i) => i.text)).toEqual(['run the tests', 'All green.'])
    // A replayed turn is finished history, not something still in flight.
    expect(state.running).toBe(false)
    expect(state.turnTiming.t1?.startedAt).toBe(0)
  })

  it('renders restart recovery without a live-looking command or approval', () => {
    const state = apply([
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 0 },
      },
      { type: 'item.started', item: item({ id: 'command-1', type: 'command' }) },
      {
        type: 'approval.requested',
        request: {
          id: 'approval-1',
          kind: 'command',
          createdAt: 1,
        },
      },
      {
        type: 'item.completed',
        item: item({ id: 'command-1', type: 'command', status: 'failed' }),
      },
      { type: 'approval.resolved', id: 'approval-1' },
      { type: 'turn.completed', turnId: 't1', status: 'interrupted' },
      {
        type: 'thread.error',
        threadId: 'th1',
        message:
          'This turn stopped when Personal Harness restarted. Review any partial changes, then send a new message to continue.',
      },
    ])

    expect(state.running).toBe(false)
    expect(state.approvals).toEqual([])
    expect(state.items).toEqual([
      expect.objectContaining({ id: 'command-1', status: 'failed' }),
      expect.objectContaining({
        type: 'error',
        status: 'completed',
        text: expect.stringContaining('send a new message to continue'),
      }),
    ])
  })

  it('batches stored deltas without changing replay semantics', () => {
    const events: DomainEvent[] = [
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 0 },
      },
      { type: 'item.started', item: item({ id: 'a1', text: '' }) },
      { type: 'item.started', item: item({ id: 'a2', text: '' }) },
      { type: 'item.delta', turnId: 't1', itemId: 'a1', textDelta: 'one' },
      { type: 'item.delta', turnId: 't1', itemId: 'a2', textDelta: 'two' },
      { type: 'item.delta', turnId: 't1', itemId: 'a1', textDelta: ' three' },
      { type: 'item.completed', item: item({ id: 'a1', status: 'completed' }) },
      { type: 'item.delta', turnId: 't1', itemId: 'a2', textDelta: ' four' },
      { type: 'item.completed', item: item({ id: 'a2', status: 'completed' }) },
      { type: 'turn.completed', turnId: 't1', status: 'completed' },
    ]

    const sequential = events.reduce(reduce, emptyThread)
    const batched = reduceEventLog(
      emptyThread,
      events.map((event, index) => ({ seq: index + 1, event })),
    )

    expect(batched).toEqual(sequential)
    expect(batched.items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'a1', text: 'one three' },
      { id: 'a2', text: 'two four' },
    ])
  })

  it('keeps parallel subagent activity final after replay and stale events', () => {
    const subagent = (id: string, status: Item['status'], text: string): Item =>
      item({ id, type: 'tool_call', role: undefined, status, text })
    const events: DomainEvent[] = [
      { type: 'item.started', item: subagent('agent-a', 'started', 'Spawning a subagent') },
      { type: 'item.started', item: subagent('agent-b', 'started', 'Spawning a subagent') },
      { type: 'item.completed', item: subagent('agent-a', 'completed', 'Spawned a subagent') },
      { type: 'item.completed', item: subagent('agent-b', 'failed', 'Subagent failed') },
      // A buffered pre-completion event may be replayed after history has
      // already restored the final item. Final items are immutable.
      { type: 'item.delta', turnId: 't1', itemId: 'agent-a', textDelta: ' stale' },
      { type: 'item.started', item: subagent('agent-a', 'started', 'Spawning a subagent') },
    ]

    const replayed = reduceEventLog(
      emptyThread,
      events.map((event, index) => ({ seq: index + 1, event })),
    )
    const live = events.reduce(reduce, emptyThread)

    expect(replayed).toEqual(live)
    expect(replayed.items.map(({ id, status, text }) => ({ id, status, text }))).toEqual([
      { id: 'agent-a', status: 'completed', text: 'Spawned a subagent' },
      { id: 'agent-b', status: 'failed', text: 'Subagent failed' },
    ])
  })

  it('replays only buffered events newer than restored history', () => {
    const started = apply([{ type: 'item.started', item: item({ text: '' }) }])
    const buffered = [
      {
        seq: 9,
        event: { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'old' },
      },
      {
        event: { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'local ' },
      },
      {
        seq: 11,
        event: { type: 'item.delta', turnId: 't1', itemId: 'i1', textDelta: 'live' },
      },
    ] satisfies Array<{ seq?: number; event: DomainEvent }>

    const state = reduceEventLog(started, buffered, 10)

    expect(state.items[0]?.text).toBe('local live')
  })

  it('tracks whether a turn is running', () => {
    const running = apply([
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 0 },
      },
    ])
    expect(running.running).toBe(true)
    expect(running.activeTurn).toEqual({ id: 't1', startedAt: 0 })

    const done = reduce(running, { type: 'turn.completed', turnId: 't1', status: 'completed' })
    expect(done.running).toBe(false)
    expect(done.activeTurn).toBeUndefined()
  })

  it('replays automatic reviews to the same final state as live events', () => {
    const started: DomainEvent = {
      type: 'approval.review.started',
      review: {
        id: 'review-1',
        turnId: 't1',
        status: 'in_progress',
        description: 'Run pnpm test',
        startedAt: 10,
      },
    }
    const completed: DomainEvent = {
      type: 'approval.review.completed',
      review: {
        ...started.review,
        status: 'approved',
        rationale: 'The test command only reads and writes inside the workspace.',
        riskLevel: 'low',
        completedAt: 20,
      },
    }

    const live = reduce(reduce(emptyThread, started), completed)
    const replayed = apply([started, completed])

    expect(replayed.reviews).toEqual(live.reviews)
    expect(replayed.reviews['review-1']).toEqual(completed.review)
  })
})

describe('overnight regression pins', () => {
  it('clears unanswerable approvals when the turn ends, however it ends', () => {
    const requested = reduce(emptyThread, {
      type: 'approval.requested',
      request: { id: 'a1', kind: 'command', command: 'rm x', createdAt: 1 },
    })
    for (const status of ['completed', 'interrupted', 'failed'] as const) {
      const ended = reduce(requested, { type: 'turn.completed', turnId: 't1', status })
      expect(ended.approvals).toEqual([])
    }
  })

  it('parks an early delta in a placeholder the real item fills without duplicating', () => {
    const early = reduce(emptyThread, {
      type: 'item.delta',
      turnId: 't1',
      itemId: 'x',
      textDelta: 'Hel',
    })
    expect(early.items).toHaveLength(1)
    expect(early.items[0]?.text).toBe('Hel')

    const started = reduce(early, {
      type: 'item.started',
      item: {
        id: 'x',
        turnId: 't1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        createdAt: 2,
      },
    })
    expect(started.items).toHaveLength(1)
    expect(started.items[0]?.text).toBe('Hel')

    const delta = reduce(started, {
      type: 'item.delta',
      turnId: 't1',
      itemId: 'x',
      textDelta: 'lo',
    })
    expect(delta.items[0]?.text).toBe('Hello')
  })
})
