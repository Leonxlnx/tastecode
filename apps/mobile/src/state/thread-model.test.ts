import { describe, expect, it } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { ThreadModel } from './thread-model'

const turn = (id: string, createdAt = 1): DomainEvent => ({
  type: 'turn.started',
  turn: { id, threadId: 't', status: 'running', createdAt },
})

const item = (patch: Partial<Item> & Pick<Item, 'id'>): Item => ({
  turnId: 'turn-1',
  type: 'message',
  status: 'started',
  role: 'assistant',
  createdAt: 1,
  ...patch,
})

describe('thread model', () => {
  it('replaces the prompt shown at once with the computer’s copy under the same id', () => {
    const model = new ThreadModel()
    model.addLocalMessage('local:1', 'Fix the tests', [])
    expect(model.view().items).toEqual([expect.objectContaining({ id: 'local:1', turnId: '' })])
    model.apply(turn('turn-1'))
    model.apply({
      type: 'item.completed',
      item: item({ id: 'local:1', role: 'user', status: 'completed', text: 'Fix the tests' }),
    })
    expect(model.view().items).toEqual([
      expect.objectContaining({ id: 'local:1', turnId: 'turn-1', role: 'user' }),
    ])
  })

  it('streams deltas into the reply and keeps them when completion carries no text', () => {
    const model = new ThreadModel()
    model.apply(turn('turn-1'))
    model.apply({ type: 'item.started', item: item({ id: 'a' }) })
    model.apply({ type: 'item.delta', turnId: 'turn-1', itemId: 'a', textDelta: 'Hel' })
    model.apply({ type: 'item.delta', turnId: 'turn-1', itemId: 'a', textDelta: 'lo' })
    expect(model.view().items[0]?.text).toBe('Hello')
    model.apply({ type: 'item.completed', item: item({ id: 'a', status: 'completed' }) })
    expect(model.view().items[0]).toMatchObject({ text: 'Hello', status: 'completed' })
    // A late delta never reopens finished work.
    model.apply({ type: 'item.delta', turnId: 'turn-1', itemId: 'a', textDelta: '!' })
    expect(model.view().items[0]?.text).toBe('Hello')
  })

  it('creates a reply from a delta that arrives before its start', () => {
    const model = new ThreadModel()
    model.apply(turn('turn-1'))
    model.apply({ type: 'item.delta', turnId: 'turn-1', itemId: 'b', textDelta: 'Hi' })
    expect(model.view().items).toEqual([
      expect.objectContaining({ id: 'b', role: 'assistant', text: 'Hi', status: 'started' }),
    ])
  })

  it('tracks approvals and questions until they are answered or the turn ends', () => {
    const model = new ThreadModel()
    model.apply(turn('turn-1'))
    model.apply({
      type: 'approval.requested',
      request: { id: 'ap', kind: 'command', command: 'rm -rf build', createdAt: 2 },
    })
    model.apply({
      type: 'user_input.requested',
      request: {
        id: 'q',
        turnId: 'turn-1',
        questions: [
          {
            id: 'x',
            header: 'Pick',
            question: 'Which?',
            allowOther: false,
            secret: false,
            options: null,
          },
        ],
        autoResolutionMs: null,
        createdAt: 2,
      },
    })
    expect(model.view().approvals).toHaveLength(1)
    expect(model.view().userInputs).toHaveLength(1)
    model.apply({ type: 'user_input.resolved', id: 'q' })
    model.apply({ type: 'turn.completed', turnId: 'turn-1', status: 'completed', completedAt: 9 })
    const view = model.view()
    expect(view.approvals).toEqual([])
    expect(view.userInputs).toEqual([])
    expect(view.running).toBe(false)
    expect(view.turnEnded['turn-1']).toBe(9)
  })

  it('stops showing work as live when its turn ends without completing it', () => {
    const model = new ThreadModel()
    model.apply(turn('turn-1'))
    model.apply({
      type: 'item.started',
      item: item({ id: 'cmd', type: 'command', command: 'npm test' }),
    })
    model.apply({ type: 'turn.completed', turnId: 'turn-1', status: 'interrupted' })
    expect(model.view().items[0]?.status).toBe('completed')
  })

  it('puts older turns before the shown ones without duplicating an item', () => {
    const model = new ThreadModel()
    model.apply({
      type: 'item.completed',
      item: item({ id: 'new', status: 'completed', text: 'b' }),
    })
    const older = new ThreadModel()
    older.apply({
      type: 'item.completed',
      item: item({ id: 'old', status: 'completed', text: 'a' }),
    })
    older.apply({
      type: 'item.completed',
      item: item({ id: 'new', status: 'completed', text: 'b' }),
    })
    model.prepend(older)
    expect(model.view().items.map((entry) => entry.id)).toEqual(['old', 'new'])
    model.apply({ type: 'item.delta', turnId: 'turn-1', itemId: 'new', textDelta: 'x' })
    expect(model.view().items[1]?.text).toBe('b')
  })

  it('records the model the provider reports working with', () => {
    const model = new ThreadModel()
    model.apply({
      type: 'usage.updated',
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
        model: 'gpt-terra',
      },
    })
    expect(model.view().model).toBe('gpt-terra')
  })

  it('returns the same view until something changes', () => {
    const model = new ThreadModel()
    const first = model.view()
    expect(model.view()).toBe(first)
    model.apply(turn('turn-1'))
    expect(model.view()).not.toBe(first)
  })
})
