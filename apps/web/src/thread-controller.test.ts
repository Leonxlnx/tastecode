import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, ResultOf } from '@harness/contracts'
import { ThreadController } from './thread-controller.js'
import { TestTransport } from './test-transport.js'
import { emptyThread, reduce, threadItems } from './thread-store.js'

const started: DomainEvent = {
  type: 'item.started',
  item: {
    id: 'item',
    turnId: 'turn',
    type: 'message',
    role: 'assistant',
    status: 'started',
    text: '',
    createdAt: 0,
  },
}
const delta: DomainEvent = { type: 'item.delta', itemId: 'item', turnId: 'turn', textDelta: 'x' }
const history = (text: string): ResultOf<'thread.history'> => ({
  events: [{ seq: 1, event: { ...started, item: { ...started.item, text } } }],
  running: false,
})
const unprotected = () => false
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ThreadController lifecycle owner', () => {
  it('replaces a partial replay when older provider turns are discovered', async () => {
    const transport = new TestTransport(() => ({ ...history('replaced'), reset: true }))
    const controller = new ThreadController(transport)
    controller.update(
      'thread',
      reduce(emptyThread, {
        ...started,
        item: { ...started.item, id: 'stale', text: 'Old branch' },
      }),
    )
    controller.setCursor('thread', 50)
    const result = await controller.loadHistory('thread', 50)
    expect(result!.visible.items.map((item) => item.text)).toEqual(['replaced'])
  })
  it.each(['local', 'server'] as const)(
    'retries recovery after a newer %s queue revision and publishes only the fresh queue',
    async (source) => {
      const replies: Array<(value: ResultOf<'thread.queue'>) => void> = []
      const transport = new TestTransport((method) =>
        method === 'thread.history'
          ? history('saved')
          : new Promise((resolve) => replies.push(resolve)),
      )
      const controller = new ThreadController(transport)
      controller.activate('thread')
      const revision = controller.beginRecovery()
      const recovery = controller.recoverThread('thread', revision, unprotected)
      const item = { id: 'queued', text: 'next', attachments: [], createdAt: 1 }
      controller.setQueue('thread', { items: [item], canSteer: true }, source)
      replies[0]!({ items: [], canSteer: false })
      await vi.waitFor(() => expect(replies).toHaveLength(2))
      expect(controller.queue('thread')?.items).toEqual([item])
      replies[1]!({ items: [item], canSteer: true })
      expect((await recovery)?.state.items).toEqual([item])
      expect(controller.queue('thread')?.items).toEqual([item])
    },
  )

  it('batches live text in one frame and flushes before a turn boundary', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const controller = new ThreadController(new TestTransport())
    controller.activate('thread')
    controller.setCursor('thread', 0)
    controller.receive({ threadId: 'thread', event: started, seq: 1 }, unprotected)
    const render = vi.fn()
    controller.frames.subscribe(render)
    for (let index = 0; index < 100; index += 1)
      controller.receive({ threadId: 'thread', event: delta, seq: index + 2 }, unprotected)
    expect(frames).toHaveLength(1)
    expect(render).not.toHaveBeenCalled()
    frames[0]!(0)
    expect(render).toHaveBeenCalledOnce()
    expect(threadItems(controller.frames.getSnapshot())[0]?.text).toBe('x'.repeat(100))
    controller.receive({ threadId: 'thread', event: delta, seq: 101 }, unprotected)
    controller.receive({ threadId: 'thread', event: delta, seq: 102 }, unprotected)
    controller.receive(
      {
        threadId: 'thread',
        event: { type: 'turn.completed', turnId: 'turn', status: 'completed' },
        seq: 103,
      },
      unprotected,
    )
    expect(threadItems(controller.frames.getSnapshot())[0]?.text).toBe('x'.repeat(101))
    expect(controller.cursor('thread')).toBe(103)
    controller.suspend()
  })

  it('does not restore a removed task from a late reconnect queue reply', async () => {
    let reply!: (value: ResultOf<'thread.queue'>) => void
    const transport = new TestTransport((method) =>
      method === 'thread.history'
        ? history('saved')
        : new Promise((resolve) => {
            reply = resolve
          }),
    )
    const controller = new ThreadController(transport)
    const recovery = controller.recoverThread('thread', controller.beginRecovery(), unprotected)
    controller.forget('thread')
    reply({
      items: [{ id: 'queued', text: 'late', attachments: [], createdAt: 1 }],
      canSteer: true,
    })
    expect(await recovery).toBeUndefined()
    expect(controller.snapshot('thread')).toBeUndefined()
    expect(controller.queue('thread')).toBeUndefined()
  })

  it('replays live output exactly once and lets the newest history read own the result', async () => {
    const replies: Array<(value: ResultOf<'thread.history'>) => void> = []
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const controller = new ThreadController(
      new TestTransport(() => new Promise((resolve) => replies.push(resolve))),
    )
    controller.activate('thread')
    const old = controller.loadHistory('thread')
    const fresh = controller.loadHistory('thread')
    controller.receive({ threadId: 'thread', event: delta, seq: 2 }, unprotected)
    replies[1]!({ ...history('new'), events: [...history('new').events, { seq: 2, event: delta }] })
    await fresh
    replies[0]!(history('old'))
    expect(await old).toBeUndefined()
    expect(threadItems(controller.snapshot('thread')!)[0]?.text).toBe('newx')
    expect(controller.cursor('thread')).toBe(2)
    controller.suspend()
  })

  it('invalidates pending history and queue metadata when the task is removed', async () => {
    let reply!: (value: ResultOf<'thread.history'>) => void
    const controller = new ThreadController(
      new TestTransport(
        () =>
          new Promise((resolve) => {
            reply = resolve
          }),
      ),
    )
    controller.update('thread', emptyThread)
    controller.setCursor('thread', 8)
    controller.setQueue('thread', { items: [], canSteer: false }, 'local')
    controller.setQueue('thread', { items: [], canSteer: false }, 'server')
    controller.submit('thread', {
      id: 'send',
      text: 'unsent',
      attachments: [],
      createdAt: 1,
      kind: 'turn',
      accepted: false,
      indeterminate: true,
    })
    const load = controller.loadHistory('thread')
    controller.forget('thread')
    reply(history('late'))
    expect(await load).toBeUndefined()
    expect(controller.snapshot('thread')).toBeUndefined()
    expect(controller.cursor('thread')).toBeUndefined()
    expect(controller.queue('thread')).toBeUndefined()
    expect(controller.queueRevision('thread', 'local')).toBe(0)
    expect(controller.queueRevision('thread', 'server')).toBe(0)
    expect(controller.hasPending('thread')).toBe(false)
  })

  it('keeps pending sends until fresh history and queues resolve their outcome', () => {
    const controller = new ThreadController(new TestTransport())
    controller.submit('thread', {
      id: 'send',
      text: 'recover me',
      attachments: ['image'],
      createdAt: 1,
      kind: 'turn',
      accepted: false,
      indeterminate: true,
    })
    expect(controller.settleSubmissions('thread', [])).toEqual([])
    expect(controller.hasPending('thread')).toBe(true)
    const rejected = controller.settleSubmissions('thread', [], emptyThread)
    expect(rejected).toHaveLength(1)
    controller.editDraft('thread', { text: 'new draft' })
    controller.recoverDraft('thread', rejected[0]!)
    expect(controller.draft('thread')).toMatchObject({
      text: 'new draft\n\nrecover me',
      attachments: ['image'],
    })
    expect(controller.hasPending('thread')).toBe(false)
  })

  it('retains bounded inactive caches and invalidates old recovery epochs', () => {
    const controller = new ThreadController(new TestTransport())
    const protectedId = 'thread-0'
    for (let index = 0; index < 20; index += 1) {
      controller.update('thread-' + index, reduce(emptyThread, started))
      controller.setCursor('thread-' + index, 1)
    }
    controller.prune((id) => id === protectedId)
    expect(controller.snapshot(protectedId)).toBeDefined()
    const retained = Array.from({ length: 20 }, (_, index) =>
      controller.snapshot('thread-' + index),
    ).filter(Boolean)
    expect(retained.length).toBeLessThanOrEqual(4)
    const old = controller.beginRecovery()
    const next = controller.beginRecovery()
    expect(controller.isCurrentRecovery(old)).toBe(false)
    expect(controller.isCurrentRecovery(next)).toBe(true)
    controller.suspend()
    expect(controller.isCurrentRecovery(next)).toBe(false)
  })
})
