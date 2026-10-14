import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { DatabaseSync } from './sqlite.js'
import { Store } from './store.js'

const THREAD = 'thread'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function newStore(location = ':memory:'): Store {
  const store = new Store(location)
  store.addProject('/repo')
  store.addThread({ id: THREAD, projectPath: '/repo', provider: 'codex', title: 'Long' })
  return store
}

function fileLocation(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-history-tail-'))
  directories.push(directory)
  return path.join(directory, 'history.db')
}

const started = (id: string): DomainEvent => ({
  type: 'turn.started',
  turn: { id, threadId: THREAD, status: 'running', createdAt: 0 },
})
const completed = (turnId: string): DomainEvent => ({
  type: 'turn.completed',
  turnId,
  status: 'completed',
})
const usage = (totalTokens: number): DomainEvent => ({
  type: 'usage.updated',
  usage: {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
  },
})
const reply = (id: string, turnId: string, text = id): DomainEvent => ({
  type: 'item.completed',
  item: { id, turnId, type: 'message', role: 'assistant', status: 'completed', text, createdAt: 0 },
})
const prompt = (id: string, turnId: string): DomainEvent => ({
  type: 'item.completed',
  item: { id, turnId, type: 'message', role: 'user', status: 'completed', text: id, createdAt: 0 },
})

/** One plain local turn, streamed like a provider would. */
function plainTurn(index: number, extra: DomainEvent[] = []): DomainEvent[] {
  const turnId = `turn-${index}`
  const item: Item = {
    id: `reply-${index}`,
    turnId,
    type: 'message',
    role: 'assistant',
    status: 'started',
    createdAt: 0,
  }
  return [
    prompt(`prompt-${index}`, turnId),
    started(turnId),
    { type: 'item.started', item },
    { type: 'item.delta', turnId, itemId: item.id, textDelta: 'Hel' },
    { type: 'item.delta', turnId, itemId: item.id, textDelta: 'lo' },
    { type: 'item.completed', item: { ...item, status: 'completed', text: 'Hello' } },
    ...extra,
    completed(turnId),
  ]
}

describe('the history index', () => {
  it.each(['one at a time', 'in batches'])(
    'names each turn and item by its first row when rows arrive %s',
    (mode) => {
      const store = newStore()
      const events: DomainEvent[] = [
        prompt('prompt', 'turn'),
        started('turn'),
        { type: 'item.delta', turnId: 'turn', itemId: 'early', textDelta: 'a' },
        { type: 'item.delta', turnId: 'turn', itemId: 'early', textDelta: 'b' },
        // Another item's delta between them starts a new run.
        { type: 'item.delta', turnId: 'other', itemId: 'side', textDelta: 'c' },
        { type: 'item.delta', turnId: 'turn', itemId: 'early', textDelta: 'd' },
        reply('early', 'turn', 'abd'),
      ]
      const seqs =
        mode === 'one at a time'
          ? events.map((event) => store.append(THREAD, event))
          : store
              .appendBatchWithSerializedEvents(events.map((event) => ({ threadId: THREAD, event })))
              .map(({ seq }) => seq)

      expect(
        store.historyKeyFirstSeqs(THREAD, [
          't:turn',
          't:other',
          'i:prompt',
          'i:early',
          'i:side',
          'i:missing',
        ]),
      ).toEqual(
        new Map([
          ['t:turn', seqs[0]],
          ['t:other', seqs[4]],
          ['i:prompt', seqs[0]],
          ['i:early', seqs[2]],
          ['i:side', seqs[4]],
        ]),
      )
      store.close()
    },
  )

  it('indexes the next delta of a run whose first delta was rolled back', () => {
    const store = newStore()
    store.append(THREAD, started('turn'))
    expect(() =>
      store.appendBatchWithSerializedEvents([
        {
          threadId: THREAD,
          event: { type: 'item.delta', turnId: 'turn', itemId: 'a', textDelta: 'x' },
        },
        // Usage rows reference their thread; this one fails the whole batch.
        { threadId: 'missing-thread', event: usage(1) },
      ]),
    ).toThrow()
    const seq = store.append(THREAD, {
      type: 'item.delta',
      turnId: 'turn',
      itemId: 'a',
      textDelta: 'y',
    })

    expect(store.historyKeyFirstSeqs(THREAD, ['i:a'])).toEqual(new Map([['i:a', seq]]))
    store.close()
  })

  it('drops the complete mark of threads another build wrote to', () => {
    const location = fileLocation()
    const store = newStore(location)
    store.addThread({ id: 'quiet', projectPath: '/repo', provider: 'codex', title: 'Quiet' })
    for (const event of plainTurn(0)) store.append(THREAD, event)
    for (const event of plainTurn(0)) store.append('quiet', event)
    store.close()

    const reopened = new Store(location)
    expect(reopened.historyIndexed(THREAD)).toBe(true)
    reopened.close()

    const raw = new DatabaseSync(location)
    raw
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, 0, ?)`)
      .run(THREAD, JSON.stringify(started('written-elsewhere')))
    raw.close()

    const afterOtherBuild = new Store(location)
    expect(afterOtherBuild.historyIndexed(THREAD)).toBe(false)
    expect(afterOtherBuild.historyIndexed('quiet')).toBe(true)
    afterOtherBuild.close()
  })

  it('forgets a deleted thread', () => {
    const store = newStore()
    for (const event of plainTurn(0)) store.append(THREAD, event)
    store.deleteThread(THREAD)

    expect(store.historyIndexed(THREAD)).toBe(false)
    expect(store.historyKeyFirstSeqs(THREAD, ['t:turn-0'])).toEqual(new Map())
    store.close()
  })
})
