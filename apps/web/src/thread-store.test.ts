import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import {
  activeTurnActivityIndices,
  activeTurnIsSearching,
  appendUserMessage,
  beginOptimisticTurn,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  threadItemAt,
  threadItemById,
  threadItems,
  type ItemDeltaEvent,
  type ThreadState,
} from './thread-store.js'
import { projectThreadItems } from './ui/turns.js'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  turnId: 't1',
  type: 'message',
  role: 'assistant',
  status: 'started',
  createdAt: 0,
  ...over,
})

function itemWithTrackedId(
  id: string,
  status: Item['status'],
  type: Item['type'],
  onIdRead: () => void,
): Item {
  const value = item({ id, status, type, text: status === 'completed' ? 'output' : '' })
  Object.defineProperty(value, 'id', {
    enumerable: true,
    get() {
      onIdRead()
      return id
    },
  })
  return value
}

const apply = (events: DomainEvent[]) => events.reduce(reduce, emptyThread)

afterEach(() => vi.unstubAllGlobals())

describe('thread reducer', () => {
  it('keeps the turn identity with the diff and clears both for the next turn', () => {
    const shown = reduce(emptyThread, {
      type: 'diff.updated',
      turnId: 'turn-with-edits',
      diff: 'diff --git a/file.txt b/file.txt',
    })
    expect(shown).toMatchObject({
      diff: 'diff --git a/file.txt b/file.txt',
      diffTurnId: 'turn-with-edits',
    })

    const next = reduce(shown, {
      type: 'turn.started',
      turn: { id: 'next-turn', threadId: 'thread-1', status: 'running', createdAt: 1 },
    })
    expect(next.diff).toBeUndefined()
    expect(next.diffTurnId).toBeUndefined()
  })

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
    expect(threadItems(state)[0]?.text).toBe('hello')
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

    expect(threadItems(batched)).toEqual(threadItems(replayed))
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

  it('keeps batched deltas from different turns equivalent to sequential events', () => {
    const current = reduce(emptyThread, {
      type: 'turn.started',
      turn: { id: 'current', threadId: 'thread', status: 'running', createdAt: 1 },
    })
    const deltas = [
      { type: 'item.delta', turnId: 'old', itemId: 'answer', textDelta: 'stale' },
      { type: 'item.delta', turnId: 'current', itemId: 'answer', textDelta: 'current' },
    ] satisfies ItemDeltaEvent[]
    const sequential = deltas.reduce(reduce, current)

    expect(threadItems(reduceDeltas(current, deltas))).toEqual(threadItems(sequential))
    expect(threadItems(sequential).map(({ text }) => text)).toEqual(['current'])
  })

  it('materializes one live overlay before appending several early items', () => {
    const base = item({ id: 'live', turnId: 't1', text: '' })
    const streamed = item({ id: 'live', turnId: 't1', text: 'streamed' })
    const items = [base]
    const state: ThreadState = {
      ...emptyThread,
      items,
      liveItems: new Map([
        [0, { item: streamed, version: 1, textUpdate: { kind: 'append', text: 'streamed' } }],
      ]),
      itemVersion: 1,
      running: true,
      activeTurn: { id: 't1', startedAt: 1 },
    }

    const next = reduceDeltas(state, [
      { type: 'item.delta', turnId: 't1', itemId: 'x', textDelta: 'one' },
      { type: 'item.delta', turnId: 't1', itemId: 'y', textDelta: 'two' },
    ])

    expect(items).toEqual([base])
    expect(next.liveItems.size).toBe(0)
    expect(next.items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'live', text: 'streamed' },
      { id: 'x', text: 'one' },
      { id: 'y', text: 'two' },
    ])
    expect(threadItemById(next, 'y')?.text).toBe('two')
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

  it('retains item locations across a long sequence of live starts and completions', () => {
    let idReads = 0
    const history = Array.from({ length: 10_000 }, (_, index) =>
      itemWithTrackedId(`history-${index}`, 'completed', 'message', () => {
        idReads += 1
        if (idReads > 11_000) throw new Error('live item lookup budget exceeded')
      }),
    )
    let state: ThreadState = { ...emptyThread, items: history }

    for (let index = 0; index < 100; index += 1) {
      const live = item({ id: `live-${index}`, text: '' })
      state = reduce(state, { type: 'item.started', item: live })
      state = reduce(state, {
        type: 'item.completed',
        item: { ...live, status: 'completed', text: `done-${index}` },
      })
    }

    expect(state.items).toHaveLength(10_100)
    expect(state.items.at(-1)?.text).toBe('done-99')
    expect(idReads).toBeLessThanOrEqual(11_000)
  })

  it('keeps retained item locations correct across immutable branches', () => {
    const base = apply([
      { type: 'item.completed', item: item({ id: 'base', status: 'completed' }) },
    ])
    const first = reduce(base, { type: 'item.started', item: item({ id: 'first' }) })
    const second = reduce(base, { type: 'item.started', item: item({ id: 'second' }) })

    const completedFirst = reduce(first, {
      type: 'item.completed',
      item: item({ id: 'first', status: 'completed', text: 'first done' }),
    })
    const completedSecond = reduce(second, {
      type: 'item.completed',
      item: item({ id: 'second', status: 'completed', text: 'second done' }),
    })

    expect(completedFirst.items.map(({ id, text }) => [id, text])).toEqual([
      ['base', undefined],
      ['first', 'first done'],
    ])
    expect(completedSecond.items.map(({ id, text }) => [id, text])).toEqual([
      ['base', undefined],
      ['second', 'second done'],
    ])
  })

  it('omits the retired Design approval warning from saved history', () => {
    const event = {
      type: 'item.completed',
      item: item({
        status: 'completed',
        text: 'Heads up: this agent cannot ask for permission mid-run, so Ask-first may block its file writes during the build. Auto or Full approval works better for Design mode.',
      }),
    } satisfies DomainEvent
    const state = reduce(emptyThread, event)
    const replayed = reduceEventLog(emptyThread, [{ seq: 1, event }])

    expect(state.items).toEqual([])
    expect(replayed.items).toEqual([])
  })

  it('replaces the exact optimistic user item with its durable completion', () => {
    const echoed = appendUserMessage(emptyThread, 'repeat this', 'submission-1')
    const state = reduce(echoed, {
      type: 'item.completed',
      item: item({ id: 'submission-1', role: 'user', status: 'completed', text: 'repeat this' }),
    })
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ id: 'submission-1', turnId: 't1' })
  })

  it('reconciles repeated prompts by exact id rather than text or order', () => {
    const echoed = appendUserMessage(
      appendUserMessage(emptyThread, 'repeat this', 'submission-1'),
      'repeat this',
      'submission-2',
    )
    const state = reduce(echoed, {
      type: 'item.completed',
      item: item({ id: 'submission-1', role: 'user', status: 'completed', text: 'repeat this' }),
    })

    expect(state.items.map(({ id, turnId }) => [id, turnId])).toEqual([
      ['submission-1', 't1'],
      ['submission-2', ''],
    ])
  })

  it('echoes a message when randomUUID is unavailable in an insecure browser context', () => {
    vi.stubGlobal('crypto', {})

    const first = appendUserMessage(emptyThread, 'sent from browser')
    const second = appendUserMessage(first, 'sent again')

    expect(second.items.map((entry) => entry.text)).toEqual(['sent from browser', 'sent again'])
    expect(second.items[0]?.id).toMatch(/^local:/)
    expect(second.items[1]?.id).not.toBe(second.items[0]?.id)
  })

  it('starts working locally before the server confirms a turn', () => {
    const state = beginOptimisticTurn(emptyThread, 'resume this chat', 'submission-with-image', 1, [
      '/work/reference.png',
    ])

    expect(state.items[0]?.text).toBe('resume this chat')
    expect(state.items[0]?.attachments).toEqual(['/work/reference.png'])
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

  it('keeps timing records immutable across turn boundaries', () => {
    const timing = { previous: { startedAt: 1, completedAt: 2 } }
    const source = { ...emptyThread, turnTiming: timing }
    const started = reduce(source, {
      type: 'turn.started',
      turn: { id: 'current', threadId: 'thread-1', status: 'running', createdAt: 10 },
    })
    const completed = reduce(started, {
      type: 'turn.completed',
      turnId: 'current',
      status: 'completed',
      completedAt: 20,
    })

    expect(source.turnTiming).toBe(timing)
    expect(timing).toEqual({ previous: { startedAt: 1, completedAt: 2 } })
    expect(started.turnTiming).not.toBe(source.turnTiming)
    expect(started.turnTiming.current).toEqual({ startedAt: 10 })
    expect(completed.turnTiming).not.toBe(started.turnTiming)
    expect(completed.turnTiming.current).toEqual({ startedAt: 10, completedAt: 20 })
    expect(started.turnTiming.current).toEqual({ startedAt: 10 })
  })

  it('projects the same elapsed time live and after replay', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const submissionId = 'local:submission-1'
    const optimistic = beginOptimisticTurn(emptyThread, 'resume this chat', submissionId)
    now.mockRestore()
    const events: DomainEvent[] = [
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 5_000 },
      },
      {
        type: 'item.started',
        item: item({ id: submissionId, role: 'user', text: 'resume this chat', createdAt: 5_000 }),
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
    expect({ ...live, itemVersion: 0 }).toEqual({ ...replayed, itemVersion: 0 })
    expect(projectThreadItems(live.items, live.turnTiming).presentations.get('t1')?.elapsedMs).toBe(
      3_000,
    )
    expect(
      projectThreadItems(replayed.items, replayed.turnTiming).presentations.get('t1')?.elapsedMs,
    ).toBe(3_000)
  })

  it('drops an incompatible context window from replayed cumulative accounting', () => {
    const replayed = reduceEventLog(emptyThread, [
      {
        seq: 1,
        event: {
          type: 'usage.updated',
          usage: {
            inputTokens: 570_000,
            cachedInputTokens: 490_000,
            outputTokens: 25_000,
            reasoningTokens: 6_152,
            totalTokens: 601_152,
            cumulative: true,
            inputIncludesCached: true,
            contextWindow: 258_400,
          },
        },
      },
    ])

    expect(replayed.usage).toEqual({
      inputTokens: 570_000,
      cachedInputTokens: 490_000,
      outputTokens: 25_000,
      reasoningTokens: 6_152,
      totalTokens: 601_152,
      cumulative: true,
      inputIncludesCached: true,
    })
  })

  it('drops an impossible context window from older unmarked accounting', () => {
    const replayed = reduceEventLog(emptyThread, [
      {
        seq: 1,
        event: {
          type: 'usage.updated',
          usage: {
            inputTokens: 1_338_252,
            cachedInputTokens: 1_230_336,
            outputTokens: 11_545,
            reasoningTokens: 6_547,
            totalTokens: 1_349_797,
            contextWindow: 258_400,
          },
        },
      },
    ])

    expect(replayed.usage?.contextWindow).toBeUndefined()
    expect(replayed.usage?.totalTokens).toBe(1_349_797)
  })

  it('preserves a cumulative context-only usage frame', () => {
    const usage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 53_000,
      cumulative: true,
      contextWindow: 200_000,
      costUsd: 0.045,
    }
    const replayed = reduceEventLog(emptyThread, [
      { seq: 1, event: { type: 'usage.updated', usage } },
    ])

    expect(replayed.usage).toEqual(usage)
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
        message: 'Turn interrupted: TasteCode restarted. Send a new message to continue.',
      },
    ])

    expect(state.running).toBe(false)
    expect(state.approvals).toEqual([])
    expect(state.items).toEqual([
      expect.objectContaining({ id: 'command-1', status: 'failed' }),
      expect.objectContaining({
        type: 'error',
        status: 'completed',
        text: 'Turn interrupted: TasteCode restarted. Send a new message to continue.',
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

    expect({ ...batched, itemVersion: 0 }).toEqual({ ...sequential, itemVersion: 0 })
    expect(batched.items.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'a1', text: 'one three' },
      { id: 'a2', text: 'two four' },
    ])
  })

  it('does not replay a stale early delta into the active turn', () => {
    const events: DomainEvent[] = [
      {
        type: 'turn.started',
        turn: { id: 'current', threadId: 'th1', status: 'running', createdAt: 1 },
      },
      { type: 'item.delta', turnId: 'old', itemId: 'answer', textDelta: 'stale' },
    ]
    const sequential = events.reduce(reduce, emptyThread)
    const replayed = reduceEventLog(
      emptyThread,
      events.map((event, index) => ({ seq: index + 1, event })),
    )

    expect(replayed.items).toEqual(sequential.items)
    expect(replayed.items).toEqual([])
  })

  it('indexes only live activity in a tool-heavy active turn', () => {
    const items: Item[] = [
      ...Array.from({ length: 10_000 }, (_, index) =>
        item({
          id: `completed-${index}`,
          type: 'tool_call',
          status: 'completed',
          text: 'read file',
          createdAt: index,
        }),
      ),
      item({ id: 'searching', type: 'tool_call', status: 'started', text: 'search files' }),
      item({ id: 'answer', type: 'message', status: 'started', text: 'Writing the answer' }),
    ]

    const indices = activeTurnActivityIndices(items, 't1')

    expect(indices).toEqual([10_000])
    expect(activeTurnIsSearching(items, 't1', undefined, 0, indices)).toBe(true)
  })

  it('replays large turn timing histories without copying the growing table per event', () => {
    const entries: Array<{ seq: number; event: DomainEvent }> = []
    for (let index = 0; index < 10_000; index += 1) {
      const turnId = `turn-${index}`
      entries.push(
        {
          seq: entries.length + 1,
          event: {
            type: 'turn.started',
            turn: {
              id: turnId,
              threadId: 'thread-1',
              status: 'running',
              createdAt: index * 2,
            },
          },
        },
        {
          seq: entries.length + 2,
          event: {
            type: 'turn.completed',
            turnId,
            status: 'completed',
            completedAt: index * 2 + 1,
          },
        },
      )
    }

    const state = reduceEventLog(emptyThread, entries)

    expect(Object.keys(state.turnTiming)).toHaveLength(10_000)
    expect(state.turnTiming['turn-0']).toEqual({ startedAt: 0, completedAt: 1 })
    expect(state.turnTiming['turn-9999']).toEqual({ startedAt: 19_998, completedAt: 19_999 })
    expect(state.running).toBe(false)
  })

  it.each([1_000, 10_000])('keeps completed replay item reads linear at %i items', (count) => {
    const readBudget = count * 12
    let idReads = 0
    const readId = () => {
      idReads += 1
      if (idReads > readBudget) throw new Error('replay item-read budget exceeded')
    }
    const entries: Array<{ seq: number; event: DomainEvent }> = []

    for (let index = 0; index < count; index += 1) {
      const id = `history-${index}`
      const type: Item['type'] = index % 2 === 0 ? 'command' : 'tool_call'
      entries.push(
        {
          seq: entries.length + 1,
          event: { type: 'item.started', item: itemWithTrackedId(id, 'started', type, readId) },
        },
        {
          seq: entries.length + 2,
          event: { type: 'item.delta', turnId: 't1', itemId: id, textDelta: 'output' },
        },
        {
          seq: entries.length + 3,
          event: { type: 'item.completed', item: itemWithTrackedId(id, 'completed', type, readId) },
        },
      )
    }

    const state = reduceEventLog(emptyThread, entries)

    expect(state.items).toHaveLength(count)
    expect(idReads).toBeLessThanOrEqual(readBudget)
  })

  it.each([1_000, 10_000])('keeps error-interleaved replay reads linear at %i items', (count) => {
    const readBudget = count * 12
    let errorId = 0
    vi.stubGlobal('crypto', { randomUUID: () => `replay-error-${errorId++}` })
    let idReads = 0
    const readId = () => {
      idReads += 1
      if (idReads > readBudget) throw new Error('error replay item-read budget exceeded')
    }
    const entries: Array<{ seq: number; event: DomainEvent }> = []

    for (let index = 0; index < count; index += 1) {
      const id = `failed-${index}`
      entries.push(
        {
          seq: entries.length + 1,
          event: {
            type: 'item.completed',
            item: itemWithTrackedId(id, 'failed', 'command', readId),
          },
        },
        {
          seq: entries.length + 2,
          event: { type: 'thread.error', threadId: 'th1', message: 'Provider disconnected' },
        },
      )
    }

    const state = reduceEventLog(emptyThread, entries)

    expect(state.items).toHaveLength(count * 2)
    expect(state.items[1]).toMatchObject({
      type: 'error',
      status: 'completed',
      text: 'Provider disconnected',
    })
    expect(idReads).toBeLessThanOrEqual(readBudget)
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

    expect({ ...replayed, itemVersion: 0 }).toEqual({ ...live, itemVersion: 0 })
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

    expect(state.items).not.toBe(started.items)
    expect(started.items[0]?.text).toBe('')
    expect(state.items[0]?.text).toBe('local live')
  })

  it('owns replay mutations while preserving identity for an empty or skipped log', () => {
    const started = apply([
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 1 },
      },
    ])
    const completed = {
      seq: 2,
      event: {
        type: 'turn.completed',
        turnId: 't1',
        status: 'completed',
        completedAt: 2,
      },
    } satisfies { seq: number; event: DomainEvent }

    expect(reduceEventLog(started, [])).toBe(started)
    expect(reduceEventLog(started, [completed], completed.seq)).toBe(started)

    const replayed = reduceEventLog(started, [completed])
    expect(replayed).not.toBe(started)
    expect(started.running).toBe(true)
    expect(started.turnTiming['t1']).toEqual({ startedAt: 1 })
    expect(replayed.running).toBe(false)
    expect(replayed.turnTiming['t1']).toEqual({ startedAt: 1, completedAt: 2 })
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
  it('retains the replay item index for bounded post-load lookups', () => {
    let reads = 0
    const events = Array.from({ length: 10_000 }, (_, index) => ({
      seq: index + 1,
      event: {
        type: 'item.started' as const,
        item: itemWithTrackedId(`history-${index}`, 'completed', 'message', () => {
          reads += 1
        }),
      },
    }))
    const state = reduceEventLog(emptyThread, events)
    const readsAfterReplay = reads

    expect(threadItemById(state, 'history-9999')?.id).toBe('history-9999')
    expect(reads - readsAfterReplay).toBeLessThanOrEqual(2)
  })

  it('reads the live overlay through the retained item index', () => {
    const base = item({ id: 'live', text: 'base' })
    const live = item({ id: 'live', text: 'streamed' })
    const state: ThreadState = {
      ...emptyThread,
      items: [base],
      liveItems: new Map([
        [0, { item: live, version: 1, textUpdate: { kind: 'append', text: 'streamed' } }],
      ]),
    }

    expect(threadItemById(state, 'live')).toBe(live)
    expect(threadItemById(state, 'missing')).toBeUndefined()
  })

  it.each(
    ([100, 1_000, 10_000] as const).flatMap((count) =>
      (['message', 'reasoning', 'command', 'tool_call', 'file_change'] as const).map((type) => ({
        count,
        type,
      })),
    ),
  )('keeps $type delta reads bounded at $count completed items', ({ count, type }) => {
    let reads = 0
    const history = Array.from({ length: count }, (_, index) =>
      item({ id: `history-${index}`, status: 'completed', text: 'done' }),
    )
    const live = item({ id: 'live', turnId: 'active', type, text: '' })
    const items = new Proxy([...history, live], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const state = {
      ...emptyThread,
      items,
      running: true,
      activeTurn: { id: 'active', startedAt: 0 },
      liveStart: count,
    }

    const next = reduceDeltas(state, [
      { type: 'item.delta', turnId: 'active', itemId: live.id, textDelta: 'x' },
    ])

    expect(next.items).toBe(items)
    expect(threadItemAt(next.items, next.liveItems, count)?.text).toBe('x')
    expect(next.liveItems.get(count)?.textUpdate).toEqual({ kind: 'append', text: 'x' })
    expect(next.liveItems.get(count)?.version).toBe(next.itemVersion)
    expect(reads).toBeLessThanOrEqual(3)
    const activeReads = reads
    for (let frame = 0; frame < 3; frame += 1) {
      reduceDeltas(next, [
        { type: 'item.delta', turnId: 'old', itemId: 'history-0', textDelta: ' stale' },
      ])
    }
    expect(reads - activeReads).toBeLessThanOrEqual(3)
  })

  it('keeps a large live overlay immutable and iterable across many frames', () => {
    const items = Array.from({ length: 100 }, (_, index) =>
      item({ id: `live-${index}`, turnId: 'active', type: 'tool_call', text: '' }),
    )
    const liveItems = new Map(
      items.map((liveItem, index) => [
        index,
        {
          item: { ...liveItem, text: 'seed' },
          version: 1,
          textUpdate: { kind: 'append' as const, text: 'seed' },
        },
      ]),
    )
    const initial: ThreadState = {
      ...emptyThread,
      items,
      liveItems,
      itemVersion: 1,
      running: true,
      activeTurn: { id: 'active', startedAt: 0 },
    }
    let current = initial
    for (let frame = 0; frame < 40; frame += 1) {
      current = reduceDeltas(current, [
        {
          type: 'item.delta',
          turnId: 'active',
          itemId: 'live-99',
          textDelta: 'x',
        },
      ])
    }

    expect(initial.liveItems.get(99)?.item.text).toBe('seed')
    expect(current.liveItems.size).toBe(100)
    expect(new Map(current.liveItems).size).toBe(100)
    expect(threadItemAt(current.items, current.liveItems, 99)?.text).toBe(`seed${'x'.repeat(40)}`)
    expect(threadItems(current)[99]?.text).toBe(`seed${'x'.repeat(40)}`)
  })

  it('materializes a completed turn once and never mutates its history objects', () => {
    const history = item({ id: 'history', status: 'completed', text: 'done' })
    const started = reduce(
      { ...emptyThread, items: [history] },
      {
        type: 'turn.started',
        turn: { id: 'active', threadId: 'thread', status: 'running', createdAt: 1 },
      },
    )
    const withItem = reduce(started, {
      type: 'item.started',
      item: item({ id: 'live', turnId: 'active', text: '' }),
    })
    const streamed = reduceDeltas(withItem, [
      { type: 'item.delta', turnId: 'active', itemId: 'live', textDelta: 'hello' },
    ])
    const completed = reduce(streamed, {
      type: 'turn.completed',
      turnId: 'active',
      status: 'completed',
    })

    expect(streamed.items).toBe(withItem.items)
    expect(completed.items[0]).toBe(history)
    expect(completed.items[1]?.text).toBe('hello')
    const nextTurn = reduce(completed, {
      type: 'turn.started',
      turn: { id: 'next', threadId: 'thread', status: 'running', createdAt: 2 },
    })
    expect(
      reduceDeltas(nextTurn, [
        { type: 'item.delta', turnId: 'active', itemId: 'live', textDelta: ' stale' },
      ]),
    ).toBe(nextTurn)
  })

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
    expect(threadItems(delta)[0]?.text).toBe('Hello')
  })
})
