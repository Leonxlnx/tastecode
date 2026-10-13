import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, ResultOf } from '@harness/contracts'
import { NEWEST_HISTORY_TURNS, OLDER_HISTORY_TURNS, ThreadController } from './thread-controller.js'
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

  it('recovers into a draft with no text without a leading blank line', () => {
    const controller = new ThreadController(new TestTransport())
    controller.editDraft('thread', { text: '', attachments: ['/work/kept.png'] })
    controller.recoverDraft('thread', { text: 'recover me', attachments: ['/work/sent.png'] })
    expect(controller.draft('thread')).toMatchObject({
      text: 'recover me',
      attachments: ['/work/kept.png', '/work/sent.png'],
    })
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

describe('history gap recovery', () => {
  it.each(['superseded', 'failed'] as const)(
    'keeps the safe replay base after a %s read',
    async (outcome) => {
      const replies: Array<{
        resolve(value: ResultOf<'thread.history'>): void
        reject(error: Error): void
      }> = []
      const transport = new TestTransport(
        () => new Promise((resolve, reject) => replies.push({ resolve, reject })),
      )
      const controller = new ThreadController(transport)
      vi.stubGlobal('requestAnimationFrame', () => 1)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      controller.activate('thread')
      controller.update('thread', reduce(emptyThread, started))
      controller.setCursor('thread', 1)
      controller.markHistoriesForRecovery()
      const first = controller.loadHistory('thread', controller.cursor('thread'))
      const firstResult = first.catch(() => undefined)
      controller.receive(
        { threadId: 'thread', seq: 3, event: { ...delta, textDelta: 'B' } },
        unprotected,
      )
      controller.flush('thread')
      expect(controller.cursor('thread')).toBe(3)
      if (outcome === 'failed') {
        replies[0]!.reject(new Error('offline'))
        await firstResult
      }
      controller.markHistoriesForRecovery()
      const second = controller.loadHistory('thread', controller.cursor('thread'))
      controller.receive(
        { threadId: 'thread', seq: 5, event: { ...delta, textDelta: 'D' } },
        unprotected,
      )
      const recovered = {
        events: ['A', 'B', 'C', 'D'].map((textDelta, index) => ({
          seq: index + 2,
          event: { ...delta, textDelta },
        })),
        running: true,
      }
      replies[1]!.resolve(recovered)
      await second
      if (outcome === 'superseded') {
        replies[0]!.resolve(recovered)
        expect(await firstResult).toBeUndefined()
      }
      expect(transport.requests.map(({ params }) => params)).toEqual([
        { threadId: 'thread', afterSeq: 1 },
        { threadId: 'thread', afterSeq: 1 },
      ])
      expect(threadItems(controller.snapshot('thread')!)[0]?.text).toBe('ABCD')
      expect(controller.cursor('thread')).toBe(5)
      expect([...controller.historyRecoveryIds()]).toEqual([])
      controller.suspend()
    },
  )

  it('does not let a read started before the gap clear recovery state', async () => {
    let resolve!: (value: ResultOf<'thread.history'>) => void
    const controller = new ThreadController(
      new TestTransport(
        () =>
          new Promise((reply) => {
            resolve = reply
          }),
      ),
    )
    controller.update('thread', reduce(emptyThread, started))
    controller.setCursor('thread', 1)
    const pending = controller.loadHistory('thread', 1)
    controller.markHistoriesForRecovery()
    resolve({ events: [], running: false })
    expect(await pending).toBeUndefined()
    expect([...controller.historyRecoveryIds()]).toEqual(['thread'])
  })

  it('releases recovery bases when their cached threads are evicted or forgotten', () => {
    const controller = new ThreadController(new TestTransport())
    for (let index = 0; index < 6; index++) {
      controller.update(String(index), reduce(emptyThread, started))
      controller.setCursor(String(index), 1)
    }
    controller.markHistoriesForRecovery()
    controller.prune(unprotected)
    expect([...controller.historyRecoveryIds()]).toEqual(['3', '4', '5'])
    controller.forget('3')
    controller.invalidateHistory('4')
    controller.discardSnapshot('5')
    expect([...controller.historyRecoveryIds()]).toEqual([])
  })

  it('refreshes unresolved input identity only after a successful owned replay', async () => {
    const replies: Array<{
      resolve(value: ResultOf<'thread.history'>): void
      reject(error: Error): void
    }> = []
    const controller = new ThreadController(
      new TestTransport(() => new Promise((resolve, reject) => replies.push({ resolve, reject }))),
    )
    const request = {
      id: 'input',
      turnId: 'turn',
      questions: [],
      createdAt: 1,
      autoResolutionMs: null,
    }
    controller.update('thread', reduce(emptyThread, { type: 'user_input.requested', request }))
    controller.setCursor('thread', 1)
    const failed = controller.loadHistory('thread', 1)
    replies[0]!.reject(new Error('offline'))
    await expect(failed).rejects.toThrow('offline')
    controller.receive({ threadId: 'thread', seq: 2, event: started }, unprotected)
    expect(controller.snapshot('thread')!.userInputs[0]).toBe(request)
    const stale = controller.loadHistory('thread', 2)
    controller.markHistoriesForRecovery()
    replies[1]!.resolve({ events: [], running: false })
    expect(await stale).toBeUndefined()
    expect(controller.snapshot('thread')!.userInputs[0]).toBe(request)
    const current = controller.loadHistory('thread', 2)
    replies[2]!.resolve({ events: [{ seq: 2, event: started }], running: false })
    await current
    expect(controller.snapshot('thread')!.userInputs[0]).toEqual(request)
    expect(controller.snapshot('thread')!.userInputs[0]).not.toBe(request)
    const confirmed = controller.snapshot('thread')!.userInputs[0]
    controller.receive({ threadId: 'thread', seq: 3, event: delta }, unprotected)
    controller.flush('thread')
    expect(controller.snapshot('thread')!.userInputs[0]).toBe(confirmed)
    const emptySuffix = controller.loadHistory('thread', 3)
    replies[3]!.resolve({ events: [], running: false })
    await emptySuffix
    expect(controller.snapshot('thread')!.userInputs[0]).toEqual(confirmed)
    expect(controller.snapshot('thread')!.userInputs[0]).not.toBe(confirmed)
    const resolved = controller.loadHistory('thread', 3)
    replies[4]!.resolve({
      events: [{ seq: 4, event: { type: 'user_input.resolved', id: request.id } }],
      running: false,
    })
    await resolved
    expect(controller.snapshot('thread')!.userInputs).toEqual([])
  })

  it('bounds completed tool payloads in an unseen running background thread', () => {
    const controller = new ThreadController(new TestTransport())
    controller.activate('foreground')
    const protectedState = (id: string) => controller.isProtected(id)
    controller.receive(
      {
        threadId: 'background',
        seq: 1,
        event: {
          type: 'turn.started',
          turn: { id: 'turn', threadId: 'background', status: 'running', createdAt: 1 },
        },
      },
      protectedState,
    )
    for (let index = 0; index < 300; index++) {
      controller.receive(
        {
          threadId: 'background',
          seq: index + 2,
          event: {
            type: 'item.completed',
            item: {
              id: String(index),
              turnId: 'turn',
              type: 'tool_call',
              status: 'completed',
              text: 'x'.repeat(8192),
              createdAt: index,
            },
          },
        },
        protectedState,
      )
      expect(controller.snapshot('background')!.items).toHaveLength(0)
    }
    expect(controller.snapshot('background')!.running).toBe(true)
    expect(controller.cursor('background')).toBeUndefined()
  })
})

describe('paged history', () => {
  const turn = (index: number, seq: number) => ({
    seq,
    event: {
      type: 'item.completed' as const,
      item: {
        id: `answer-${index}`,
        turnId: `turn-${index}`,
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'completed' as const,
        text: `Answer ${index}`,
        createdAt: index,
      },
    },
  })
  const newest = (olderCursor: string | null): ResultOf<'thread.history'> => ({
    events: [turn(2, 7), turn(3, 9)],
    running: false,
    page: { olderCursor, snapshotSeq: 9 },
  })
  const older: ResultOf<'thread.history'> = {
    events: [turn(0, 2), turn(1, 4)],
    running: false,
    page: { olderCursor: null, snapshotSeq: 9 },
  }
  const pageOf = (params: unknown) => (params as { page?: { before?: string } }).page
  const texts = (controller: ThreadController) =>
    controller.snapshot('thread')!.items.map((item) => item.text)

  it('opens with the newest turns and prepends older pages on demand', async () => {
    const transport = new TestTransport((_, params) =>
      pageOf(params)?.before === 'cursor' ? older : newest('cursor'),
    )
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    expect(transport.requests[0]!.params).toEqual({
      threadId: 'thread',
      page: { turnLimit: NEWEST_HISTORY_TURNS },
    })
    expect(texts(controller)).toEqual(['Answer 2', 'Answer 3'])
    expect(controller.snapshot('thread')!.olderCursor).toBe('cursor')
    expect(controller.cursor('thread')).toBe(9)
    const liveStart = controller.snapshot('thread')!.liveStart

    // Scrolling and find can ask at once; one read serves both.
    await Promise.all([
      controller.loadOlderHistory('thread'),
      controller.loadOlderHistory('thread'),
    ])
    expect(transport.requests.slice(1).map((request) => request.params)).toEqual([
      { threadId: 'thread', page: { before: 'cursor', turnLimit: OLDER_HISTORY_TURNS } },
    ])
    expect(texts(controller)).toEqual(['Answer 0', 'Answer 1', 'Answer 2', 'Answer 3'])
    expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
    // Indexes past the prepended rows still name the same live tail.
    expect(controller.snapshot('thread')!.liveStart).toBe(liveStart + 2)
    expect(controller.cursor('thread')).toBe(9)

    await controller.loadOlderHistory('thread')
    expect(transport.requests).toHaveLength(2)
  })

  it('keeps the cursor through a live catch-up read', async () => {
    const transport = new TestTransport((_, params) =>
      (params as { afterSeq?: number }).afterSeq === 9
        ? { events: [turn(4, 11)], running: false }
        : newest('cursor'),
    )
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    await controller.loadHistory('thread', 9)
    expect(transport.requests[1]!.params).toEqual({ threadId: 'thread', afterSeq: 9 })
    expect(texts(controller)).toEqual(['Answer 2', 'Answer 3', 'Answer 4'])
    expect(controller.snapshot('thread')!.olderCursor).toBe('cursor')
    expect(controller.cursor('thread')).toBe(11)
  })

  it('opens the whole history from a server that does not page', async () => {
    const transport = new TestTransport(() => ({
      events: [turn(0, 2), turn(1, 4)],
      running: false,
    }))
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
    expect(controller.cursor('thread')).toBe(4)
    await controller.loadOlderHistory('thread')
    expect(transport.requests).toHaveLength(1)
  })

  it('reopens from the newest page when a restore removed the cursor turn', async () => {
    let restored = false
    const transport = new TestTransport((_, params) => {
      if (pageOf(params)?.before === 'cursor') {
        restored = true
        return { ...newest(null), events: [turn(0, 2)], reset: true }
      }
      return restored ? { ...newest(null), events: [turn(0, 2)] } : newest('cursor')
    })
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    await controller.loadOlderHistory('thread')
    expect(transport.requests.map((request) => pageOf(request.params))).toEqual([
      { turnLimit: NEWEST_HISTORY_TURNS },
      { before: 'cursor', turnLimit: OLDER_HISTORY_TURNS },
      { turnLimit: NEWEST_HISTORY_TURNS },
    ])
    expect(texts(controller)).toEqual(['Answer 0'])
    expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
  })

  it('drops an older page whose cursor a reload has replaced', async () => {
    let reply!: (value: ResultOf<'thread.history'>) => void
    let opens = 0
    const transport = new TestTransport((_, params) => {
      if (pageOf(params)?.before) return new Promise((resolve) => (reply = resolve))
      opens += 1
      return newest(opens === 1 ? 'first' : 'second')
    })
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    const read = controller.loadOlderHistory('thread')
    await controller.loadHistory('thread')
    reply(older)
    await read
    expect(texts(controller)).toEqual(['Answer 2', 'Answer 3'])
    expect(controller.snapshot('thread')!.olderCursor).toBe('second')
  })

  describe('complete history for find', () => {
    const answer = (index: number, seq: number, text: string) => {
      const entry = turn(index, seq)
      return { seq, event: { ...entry.event, item: { ...entry.event.item, text } } }
    }
    const deferred = () => {
      let reply!: (value: ResultOf<'thread.history'>) => void
      const transport = new TestTransport((_, params) => {
        const page = pageOf(params)
        if (page === undefined) return new Promise((resolve) => (reply = resolve))
        return page.before === 'cursor'
          ? { events: [turn(1, 4)], running: false, page: { olderCursor: 'top', snapshotSeq: 9 } }
          : newest('cursor')
      })
      return { transport, reply: (value: ResultOf<'thread.history'>) => reply(value) }
    }
    const complete: ResultOf<'thread.history'> = {
      events: [turn(0, 2), turn(1, 4), answer(2, 7, 'Answer 2 as replayed'), turn(3, 9)],
      running: false,
    }

    it('adds every older turn from one unpaged read and keeps the loaded rows', async () => {
      const { transport, reply } = deferred()
      const controller = new ThreadController(transport)
      await controller.loadHistory('thread')
      const liveStart = controller.snapshot('thread')!.liveStart
      const read = controller.loadCompleteHistory('thread')
      expect(transport.requests[1]!.params).toEqual({ threadId: 'thread' })

      // A row streamed while the read was out is already loaded.
      controller.receive({ threadId: 'thread', seq: 11, event: turn(4, 11).event }, () => false)
      reply(complete)
      await read

      expect(texts(controller)).toEqual([
        'Answer 0',
        'Answer 1',
        'Answer 2',
        'Answer 3',
        'Answer 4',
      ])
      expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
      expect(controller.snapshot('thread')!.liveStart).toBe(liveStart + 2)
      expect(controller.cursor('thread')).toBe(11)
      expect(transport.requests).toHaveLength(2)
    })

    it('drops a read its caller gave up on', async () => {
      const { transport, reply } = deferred()
      const controller = new ThreadController(transport)
      await controller.loadHistory('thread')
      const abort = new AbortController()
      const read = controller.loadCompleteHistory('thread', abort.signal)
      abort.abort()
      reply(complete)
      await read
      expect(texts(controller)).toEqual(['Answer 2', 'Answer 3'])
      expect(controller.snapshot('thread')!.olderCursor).toBe('cursor')
    })

    it('adds only what an older page that landed first left out', async () => {
      const { transport, reply } = deferred()
      const controller = new ThreadController(transport)
      await controller.loadHistory('thread')
      const read = controller.loadCompleteHistory('thread')
      await controller.loadOlderHistory('thread')
      expect(texts(controller)).toEqual(['Answer 1', 'Answer 2', 'Answer 3'])
      reply(complete)
      await read
      expect(texts(controller)).toEqual(['Answer 0', 'Answer 1', 'Answer 2', 'Answer 3'])
      expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
    })

    it('reopens from the newest page and fails when the history lacks the first loaded row', async () => {
      const { transport, reply } = deferred()
      const controller = new ThreadController(transport)
      await controller.loadHistory('thread')
      const read = controller.loadCompleteHistory('thread')
      reply({ events: [turn(0, 2), turn(3, 9)], running: false })
      // Nothing older was added, so find must not count the read as done.
      await expect(read).rejects.toThrow('thread history changed while reading it')
      expect(transport.requests.map((request) => pageOf(request.params))).toEqual([
        { turnLimit: NEWEST_HISTORY_TURNS },
        undefined,
        { turnLimit: NEWEST_HISTORY_TURNS },
      ])
      expect(texts(controller)).toEqual(['Answer 2', 'Answer 3'])
    })
  })

  it('drops an older page when flushing compacts its background thread', async () => {
    let reply!: (value: ResultOf<'thread.history'>) => void
    const transport = new TestTransport((_, params) =>
      pageOf(params)?.before
        ? new Promise((resolve) => (reply = resolve))
        : {
            events: [
              turn(2, 7),
              {
                seq: 8,
                event: {
                  type: 'turn.started',
                  turn: { id: 'turn-4', threadId: 'thread', status: 'running', createdAt: 4 },
                },
              },
              {
                seq: 9,
                event: {
                  type: 'item.started',
                  item: {
                    id: 'long',
                    turnId: 'turn-4',
                    type: 'message',
                    role: 'assistant',
                    status: 'started',
                    // Past the running-transcript budget a background thread may keep.
                    text: 'x'.repeat(300 * 1024),
                    createdAt: 4,
                  },
                },
              },
            ],
            running: true,
            page: { olderCursor: 'cursor', snapshotSeq: 9 },
          },
    )
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    controller.activate('other')
    const read = controller.loadOlderHistory('thread')
    const unprotected = () => false
    const delta = (seq: number, characters: number) =>
      controller.receive(
        {
          threadId: 'thread',
          seq,
          event: {
            type: 'item.delta',
            turnId: 'turn-4',
            itemId: 'long',
            textDelta: 'y'.repeat(characters),
          },
        },
        unprotected,
      )
    // 63 KB of streamed text is flushed by the next structural event; the
    // 2 KB after it stay buffered until the page arrives and flushes them.
    delta(10, 63 * 1024)
    controller.receive(
      {
        threadId: 'thread',
        seq: 11,
        event: {
          type: 'usage.updated',
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningTokens: 0,
            totalTokens: 2,
          },
        },
      },
      unprotected,
    )
    delta(12, 2 * 1024)
    expect(controller.snapshot('thread')!.olderCursor).toBe('cursor')

    reply(older)
    await read
    // That flush crossed the compaction check and dropped the rows the cursor
    // pointed above, so the page has nowhere to go.
    expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
    expect(texts(controller)).not.toContain('Answer 0')
  })

  it('keeps a background thread partial when a structural event compacts it', async () => {
    const transport = new TestTransport(() => ({
      events: [
        turn(2, 7),
        {
          seq: 8,
          event: {
            type: 'turn.started',
            turn: { id: 'turn-4', threadId: 'thread', status: 'running', createdAt: 4 },
          },
        },
        {
          seq: 9,
          event: {
            type: 'item.started',
            item: {
              id: 'long',
              turnId: 'turn-4',
              type: 'message',
              role: 'assistant',
              status: 'started',
              // Past the running-transcript budget a background thread may keep.
              text: 'x'.repeat(300 * 1024),
              createdAt: 4,
            },
          },
        },
      ],
      running: true,
      page: { olderCursor: 'cursor', snapshotSeq: 9 },
    }))
    const controller = new ThreadController(transport)
    await controller.loadHistory('thread')
    controller.activate('other')
    const delta = (seq: number, characters: number) =>
      controller.receive(
        {
          threadId: 'thread',
          seq,
          event: {
            type: 'item.delta',
            turnId: 'turn-4',
            itemId: 'long',
            textDelta: 'y'.repeat(characters),
          },
        },
        unprotected,
      )
    const usage = (seq: number) =>
      controller.receive(
        {
          threadId: 'thread',
          seq,
          event: {
            type: 'usage.updated',
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              reasoningTokens: 0,
              totalTokens: 2,
            },
          },
        },
        unprotected,
      )
    // The flush ahead of the second usage event crosses the compaction check.
    delta(10, 63 * 1024)
    usage(11)
    delta(12, 2 * 1024)
    usage(13)
    expect(controller.snapshot('thread')!.items).toEqual([])
    expect(controller.snapshot('thread')!.olderCursor).toBeUndefined()
    // The rows before the compaction are gone, so no suffix read can restore them.
    expect(controller.cursor('thread')).toBeUndefined()

    // Reopening the thread the way a selection does fetches the newest page again.
    controller.activate('thread')
    await controller.loadHistory('thread', controller.cursor('thread'))
    expect(transport.requests.at(-1)!.params).toEqual({
      threadId: 'thread',
      page: { turnLimit: NEWEST_HISTORY_TURNS },
    })
    expect(texts(controller)[0]).toBe('Answer 2')
    expect(controller.snapshot('thread')!.olderCursor).toBe('cursor')
  })
})
