import { describe, expect, it } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { appendUserMessage, emptyThread, reduce } from './thread-store.js'

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

describe('thread reducer', () => {
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

  it('tracks whether a turn is running', () => {
    const running = apply([
      {
        type: 'turn.started',
        turn: { id: 't1', threadId: 'th1', status: 'running', createdAt: 0 },
      },
    ])
    expect(running.running).toBe(true)

    const done = reduce(running, { type: 'turn.completed', turnId: 't1', status: 'completed' })
    expect(done.running).toBe(false)
  })
})
