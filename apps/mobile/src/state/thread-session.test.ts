import { describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import type { Connection } from '../link/connection'
import { IndeterminateError } from '../link/errors'
import { ThreadSession } from './thread-session'

type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>

function fakeConnection(handler: Handler) {
  const channels = new Map<string, Set<(data: unknown) => void>>()
  const openListeners = new Set<() => void>()
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const connection = {
    request: vi.fn((method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return handler(method, params)
    }),
    on: (channel: string, listener: (data: unknown) => void) => {
      const set = channels.get(channel) ?? new Set()
      set.add(listener)
      channels.set(channel, set)
      return () => set.delete(listener)
    },
    onOpen: (listener: () => void) => {
      openListeners.add(listener)
      return () => openListeners.delete(listener)
    },
    onGap: () => () => undefined,
  }
  return {
    connection: connection as unknown as Connection,
    requests,
    push: (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    },
    reopen: () => {
      for (const listener of openListeners) listener()
    },
  }
}

const reply = (id: string, text: string, status: Item['status'] = 'completed'): DomainEvent => ({
  type: 'item.completed',
  item: { id, turnId: 'turn-1', type: 'message', role: 'assistant', status, text, createdAt: 1 },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('thread session', () => {
  it('applies live events that arrive during the first read exactly once', async () => {
    const history = deferred<unknown>()
    const fake = fakeConnection(async (method) => {
      if (method === 'thread.history') return history.promise
      if (method === 'thread.queue') return { items: [], canSteer: false }
      throw new Error(method)
    })
    const session = new ThreadSession('t', fake.connection)
    // Already in the snapshot the read returns, then one that came after it.
    fake.push('thread.event', { threadId: 't', seq: 2, event: reply('a', 'first') })
    fake.push('thread.event', { threadId: 't', seq: 3, event: reply('b', 'second') })
    fake.push('thread.event', { threadId: 'other', seq: 4, event: reply('z', 'elsewhere') })
    history.resolve({
      events: [
        {
          seq: 1,
          event: {
            type: 'turn.started',
            turn: { id: 'turn-1', threadId: 't', status: 'running', createdAt: 1 },
          },
        },
        { seq: 2, event: reply('a', 'first') },
      ],
      running: true,
      approval: 'auto',
      page: { olderCursor: 'older', snapshotSeq: 2 },
    })
    await session.load()
    const state = session.state.get()
    expect(state.status).toBe('ready')
    expect(state.approval).toBe('auto')
    expect(state.olderCursor).toBe('older')
    expect(state.view.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(state.view.running).toBe(true)
    session.dispose()
  })

  it('catches up from the last event it applied after the link reopens', async () => {
    let reads = 0
    const fake = fakeConnection(async (method, params) => {
      if (method === 'thread.queue') return { items: [], canSteer: false }
      if (method !== 'thread.history') throw new Error(method)
      reads += 1
      if (params['afterSeq'] === undefined) {
        return {
          events: [{ seq: 4, event: reply('a', 'first') }],
          running: false,
          page: { olderCursor: null, snapshotSeq: 4 },
        }
      }
      return { events: [{ seq: 5, event: reply('b', 'while away') }], running: false }
    })
    const session = new ThreadSession('t', fake.connection)
    await session.load()
    fake.reopen()
    await settle()
    expect(
      fake.requests.filter((request) => request.method === 'thread.history').at(-1)?.params,
    ).toMatchObject({
      afterSeq: 4,
    })
    expect(session.state.get().view.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(reads).toBe(2)
    session.dispose()
  })

  it('moves a prompt sent during a turn to the queue', async () => {
    const fake = fakeConnection(async (method) => {
      if (method === 'thread.history') {
        return {
          events: [
            {
              seq: 1,
              event: {
                type: 'turn.started',
                turn: { id: 'turn-1', threadId: 't', status: 'running', createdAt: 1 },
              },
            },
          ],
          running: true,
        }
      }
      if (method === 'thread.queue') return { items: [], canSteer: true }
      if (method === 'thread.sendTurn') {
        return {
          queued: true,
          queuedTurn: { id: 'q1', text: 'next', attachments: [], createdAt: 2 },
        }
      }
      throw new Error(method)
    })
    const session = new ThreadSession('t', fake.connection)
    await session.load()
    await session.send('next', [], { model: 'm', effort: 'high' })
    expect(session.state.get().view.items).toEqual([])
    expect(
      fake.requests.find((request) => request.method === 'thread.sendTurn')?.params,
    ).toMatchObject({
      text: 'next',
      model: 'm',
      effort: 'high',
      clientSubmissionId: expect.stringMatching(/^local:/),
    })
    fake.push('thread.queue', {
      threadId: 't',
      items: [{ id: 'q1', text: 'next', attachments: [], createdAt: 2 }],
      canSteer: true,
    })
    expect(session.state.get().queue).toHaveLength(1)
    session.dispose()
  })

  it('shows queue changes at once and puts them right when the computer refuses', async () => {
    const running = {
      events: [
        {
          seq: 1,
          event: {
            type: 'turn.started',
            turn: { id: 'turn-1', threadId: 't', status: 'running', createdAt: 1 },
          },
        },
      ],
      running: true,
    }
    const listed = [
      { id: 'a', text: 'first', attachments: [], createdAt: 1 },
      { id: 'b', text: 'second', attachments: [], createdAt: 2 },
    ]
    const sent = deferred<unknown>()
    const fake = fakeConnection(async (method) => {
      if (method === 'thread.history') return running
      if (method === 'thread.queue') return { items: listed, canSteer: true }
      if (method === 'thread.sendTurn') return sent.promise
      if (method === 'thread.moveQueuedTurn') throw new Error('No longer queued')
      if (method === 'thread.deleteQueuedTurn') return {}
      throw new Error(method)
    })
    const session = new ThreadSession('t', fake.connection)
    await session.load()
    await settle()
    const ids = () => session.state.get().queue.map((entry) => entry.id)

    // A prompt sent during the turn is in the queue before the computer answers.
    const sending = session.send('third', [], {})
    expect(session.state.get().queue.at(-1)).toMatchObject({ text: 'third' })
    const local = ids().at(-1)!
    expect(session.state.get().unconfirmed.has(local)).toBe(true)
    // A list the computer sends meanwhile keeps the prompt still on its way.
    fake.push('thread.queue', { threadId: 't', items: listed, canSteer: true })
    expect(ids()).toEqual(['a', 'b', local])
    sent.resolve({
      queued: true,
      queuedTurn: { id: 'c', text: 'third', attachments: [], createdAt: 3 },
    })
    await sending
    expect(session.state.get().unconfirmed.size).toBe(0)

    // A refused move comes back as the computer's order; removing is instant.
    await expect(session.reorderQueued('a', 1)).rejects.toThrow('No longer queued')
    await settle()
    expect(ids()).toEqual(['a', 'b'])
    void session.deleteQueued('a')
    expect(ids()).toEqual(['b'])
    session.dispose()
  })

  it('drags a prompt several places in single steps and takes one back to edit', async () => {
    const listed = ['a', 'b', 'c', 'd'].map((id, index) => ({
      id,
      text: `prompt ${id}`,
      attachments: id === 'b' ? ['/tmp/b.png'] : [],
      createdAt: index,
    }))
    const fake = fakeConnection(async (method) => {
      if (method === 'thread.history') return { events: [], running: false }
      if (method === 'thread.queue') return { items: listed, canSteer: false }
      if (method === 'thread.moveQueuedTurn' || method === 'thread.deleteQueuedTurn') return {}
      throw new Error(method)
    })
    const session = new ThreadSession('t', fake.connection)
    await session.load()
    await settle()
    const ids = () => session.state.get().queue.map((entry) => entry.id)

    const moving = session.reorderQueued('d', 1)
    expect(ids()).toEqual(['a', 'd', 'b', 'c'])
    await moving
    const moves = fake.requests.filter((request) => request.method === 'thread.moveQueuedTurn')
    expect(moves.map((request) => request.params['direction'])).toEqual(['up', 'up'])

    await expect(session.takeQueued('b')).resolves.toEqual({
      text: 'prompt b',
      attachments: ['/tmp/b.png'],
    })
    expect(ids()).toEqual(['a', 'd', 'c'])
    session.dispose()
  })

  it('takes back a refused prompt but keeps one that may have arrived', async () => {
    let failure: Error = new Error('refused')
    const fake = fakeConnection(async (method) => {
      if (method === 'thread.history') return { events: [], running: false }
      if (method === 'thread.queue') return { items: [], canSteer: false }
      if (method === 'thread.sendTurn') throw failure
      throw new Error(method)
    })
    const session = new ThreadSession('t', fake.connection)
    await session.load()
    await expect(session.send('hello', [], {})).rejects.toThrow('refused')
    expect(session.state.get().view.items).toEqual([])
    failure = new IndeterminateError('dropped')
    await expect(session.send('hello again', [], {})).rejects.toThrow('dropped')
    expect(session.state.get().view.items.map((item) => item.text)).toEqual(['hello again'])
    session.dispose()
  })
})
