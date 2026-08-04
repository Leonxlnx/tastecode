import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { appendUserMessage, beginOptimisticTurn, emptyThread, reduce } from './thread-store.js'

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
