import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { readHistoryPage } from './history-page.js'
import { compactHistoryReplay } from './history-replay.js'
import { readIndexedNewestHistoryPage } from './history-tail.js'
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

/** The page the full read gives: every row parsed, compacted, then cut. */
function expectedPage(store: Store, turnLimit: number) {
  return readHistoryPage(THREAD, compactHistoryReplay(store.history(THREAD)), { turnLimit })
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const started = (id: string, createdAt = 0): DomainEvent => ({
  type: 'turn.started',
  turn: { id, threadId: THREAD, status: 'running', createdAt },
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
const approval = (id: string): DomainEvent => ({
  type: 'approval.requested',
  request: { id, kind: 'command', command: 'pnpm test', createdAt: 0 },
})
const question = (id: string, turnId: string): DomainEvent => ({
  type: 'user_input.requested',
  request: {
    id,
    turnId,
    questions: [
      {
        id: 'choice',
        header: 'Choice',
        question: 'Which one?',
        allowOther: true,
        secret: false,
        options: null,
      },
    ],
    autoResolutionMs: null,
    createdAt: 0,
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

/**
 * A long, untidy session: prompts recorded before their turn starts,
 * overlapping turns, delta-first items, items completed turns later, repeated
 * usage, diff and plan reports, approvals and questions left open or asked
 * again, reviews and thread errors. Rows go through both write paths.
 */
function writeSession(store: Store, seed: number): void {
  const next = mulberry32(seed)
  const chance = (probability: number) => next() < probability
  const count = (max: number) => Math.floor(next() * (max + 1))
  let batch: Array<{ threadId: string; event: DomainEvent }> = []
  const flush = () => {
    if (batch.length > 0) store.appendBatchWithSerializedEvents(batch)
    batch = []
  }
  const write = (event: DomainEvent) => {
    if (chance(0.5)) {
      batch.push({ threadId: THREAD, event })
      if (batch.length >= 16) flush()
    } else {
      flush()
      store.append(THREAD, event)
    }
  }

  const openApprovals: string[] = []
  const openQuestions: string[] = []
  const unfinished: Item[] = []
  let pendingCompletion: string | undefined
  let items = 0
  let tokens = 0
  const turns = 25 + count(25)
  for (let index = 0; index < turns; index += 1) {
    const turnId = `turn-${index}`
    if (chance(0.7)) write(prompt(`prompt-${index}`, turnId))
    write(started(turnId))
    // An earlier provider turn that ended after this one started.
    if (pendingCompletion !== undefined) {
      write(completed(pendingCompletion))
      pendingCompletion = undefined
    }
    for (let itemIndex = count(5); itemIndex >= 0; itemIndex -= 1) {
      const id = `item-${(items += 1)}`
      const item: Item = {
        id,
        turnId,
        type: chance(0.5) ? 'message' : 'command',
        ...(chance(0.5) ? { role: 'assistant' as const } : {}),
        status: 'started',
        createdAt: index,
      }
      const kind = next()
      if (kind < 0.45) {
        write({ type: 'item.started', item: chance(0.2) ? { ...item, turnId: '' } : item })
        for (let delta = count(4); delta >= 0; delta -= 1) {
          write({ type: 'item.delta', turnId, itemId: id, textDelta: `${delta}.` })
        }
        const text = chance(0.3) ? '' : `${id} done`
        write({ type: 'item.completed', item: { ...item, status: 'completed', text } })
      } else if (kind < 0.65) {
        write({ type: 'item.completed', item: { ...item, status: 'completed', text: id } })
      } else if (kind < 0.8) {
        // Recovery input: deltas before any item boundary.
        for (let delta = count(3); delta >= 0; delta -= 1) {
          write({ type: 'item.delta', turnId, itemId: id, textDelta: `${delta}~` })
        }
        if (chance(0.7)) {
          write({ type: 'item.completed', item: { ...item, status: 'completed', text: id } })
        }
      } else if (kind < 0.92) {
        write({ type: 'item.started', item })
        if (chance(0.15)) unfinished.push(item)
        else write({ type: 'item.completed', item: { ...item, status: 'completed' } })
      } else {
        // A tool that finishes a few turns after it started; older ones never do.
        const late = unfinished.findIndex((candidate) => candidate.createdAt >= index - 3)
        if (late >= 0) {
          const [item] = unfinished.splice(late, 1)
          write({ type: 'item.completed', item: { ...item!, status: 'completed', text: 'late' } })
        }
      }
      if (chance(0.25)) write({ type: 'diff.updated', turnId, diff: `diff ${id}` })
      if (chance(0.2))
        write({ type: 'plan.updated', turnId, steps: [{ text: id, status: 'done' }] })
      if (chance(0.3)) write(usage((tokens += 1)))
    }
    if (chance(0.2)) {
      const id = `approval-${index}`
      write(approval(id))
      if (chance(0.5)) write({ type: 'approval.resolved', id })
      else openApprovals.push(id)
    }
    if (chance(0.1) && openApprovals.length > 0) write(approval(openApprovals[0]!))
    if (chance(0.15)) {
      const id = `question-${index}`
      write(question(id, turnId))
      openQuestions.push(id)
    }
    if (chance(0.2) && openQuestions.length > 0) {
      write({ type: 'user_input.resolved', id: openQuestions.shift()! })
    }
    if (chance(0.1)) {
      const review = {
        id: `review-${index}`,
        turnId,
        status: 'in_progress' as const,
        description: 'Run the tests',
        startedAt: 0,
      }
      write({ type: 'approval.review.started', review })
      write({ type: 'approval.review.completed', review: { ...review, status: 'approved' } })
    }
    if (chance(0.05)) write({ type: 'thread.error', threadId: THREAD, message: 'failed' })
    if (chance(0.15)) pendingCompletion = turnId
    else if (chance(0.92)) write(completed(turnId))
  }
  flush()
}

describe('the indexed newest history page', () => {
  it('equals the page cut from the compacted whole log', () => {
    let answered = 0
    let asked = 0
    for (let seed = 1; seed <= 40; seed += 1) {
      const store = newStore()
      writeSession(store, seed)
      for (const turnLimit of [1, 2, 4, 10]) {
        const expected = expectedPage(store, turnLimit)
        for (const firstReadRows of [1, 9, 64]) {
          asked += 1
          const page = readIndexedNewestHistoryPage(store, THREAD, turnLimit, firstReadRows)
          if (!page) continue
          answered += 1
          expect(page, `seed ${seed}, ${turnLimit} turns, ${firstReadRows} rows`).toEqual(expected)
        }
      }
      store.close()
    }
    // The equivalence must come from bounded reads, not from falling back.
    expect(answered).toBeGreaterThan(asked / 2)
  })

  it('reads only the end of a long thread', () => {
    const store = newStore()
    for (let index = 0; index < 200; index += 1) {
      store.appendBatchWithSerializedEvents(
        plainTurn(index, [usage(index)]).map((event) => ({ threadId: THREAD, event })),
      )
    }
    const read = vi.spyOn(store, 'historyRowsBefore')
    const page = readIndexedNewestHistoryPage(store, THREAD, 10)

    expect(page).toEqual(expectedPage(store, 10))
    const rows = read.mock.results.reduce(
      (total, result) => total + (result.value as { entries: unknown[] }).entries.length,
      0,
    )
    expect(rows).toBeLessThan(store.history(THREAD).length / 2)
    store.close()
  })

  it('carries usage, approvals and questions that older rows left open', () => {
    const store = newStore()
    const append = (events: DomainEvent[]) =>
      store.appendBatchWithSerializedEvents(events.map((event) => ({ threadId: THREAD, event })))
    append(plainTurn(0, [usage(1), question('asked-early', 'turn-0'), usage(2)]))
    for (let index = 1; index < 36; index += 1) append(plainTurn(index))
    // Two turns that never completed: nothing closed the approval.
    append([prompt('prompt-36', 'turn-36'), started('turn-36'), approval('pending')])
    const interrupted = plainTurn(37).slice(0, -1)
    append(interrupted)
    append(plainTurn(38))
    append(plainTurn(39))
    const carry = vi.spyOn(store, 'historyCarryBefore')

    // The first read holds turns 37 to 39 exactly, so the carry comes from the index.
    const page = readIndexedNewestHistoryPage(store, THREAD, 2, interrupted.length + 14)

    expect(carry).toHaveBeenCalledTimes(1)
    expect(page).toEqual(expectedPage(store, 2))
    expect(page!.events.slice(0, 4).map(({ event }) => event.type)).toEqual([
      'user_input.requested',
      'usage.updated',
      'approval.requested',
      'item.completed',
    ])
    store.close()
  })

  it('leaves imported provider turns and threads another build wrote to the full read', () => {
    const location = fileLocation()
    let store = newStore(location)
    for (let index = 0; index < 30; index += 1) {
      for (const event of plainTurn(index)) store.append(THREAD, event)
    }
    expect(readIndexedNewestHistoryPage(store, THREAD, 2, 8)).toEqual(expectedPage(store, 2))
    store.close()

    // An older build appends without indexing; the next start notices.
    const raw = new DatabaseSync(location)
    const insert = raw.prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, 0, ?)`)
    for (const event of plainTurn(30)) insert.run(THREAD, JSON.stringify(event))
    raw.close()
    store = new Store(location)
    expect(store.historyIndexed(THREAD)).toBe(false)
    expect(readIndexedNewestHistoryPage(store, THREAD, 2, 8)).toBeUndefined()
    store.backfillHistoryIndex(THREAD, store.history(THREAD))
    expect(readIndexedNewestHistoryPage(store, THREAD, 2, 8)).toEqual(expectedPage(store, 2))

    store.append(THREAD, started('import:provider-turn'))
    expect(readIndexedNewestHistoryPage(store, THREAD, 2, 8)).toBeUndefined()
    store.close()
  })

  it('keeps a turn that ended turns later in one block with the turns between', () => {
    const store = newStore()
    const append = (events: DomainEvent[]) =>
      store.appendBatchWithSerializedEvents(events.map((event) => ({ threadId: THREAD, event })))
    for (let index = 0; index < 21; index += 1) append(plainTurn(index))
    const tool: Item = {
      id: 'slow-tool',
      turnId: 'turn-21',
      type: 'command',
      status: 'started',
      command: 'pnpm build',
      createdAt: 21,
    }
    // Turn 21 reports its end two turns later; its tool finishes then too.
    append(plainTurn(21, [{ type: 'item.started', item: tool }]).slice(0, -1))
    append(plainTurn(22))
    append(
      plainTurn(23, [
        { type: 'item.completed', item: { ...tool, status: 'completed', exitCode: 0 } },
        completed('turn-21'),
      ]),
    )
    append(plainTurn(24))
    append(plainTurn(25))

    for (const turnLimit of [3, 4]) {
      const expected = expectedPage(store, turnLimit)
      const turns = expected.events.flatMap(({ event }) =>
        event.type === 'turn.started' ? [event.turn.id] : [],
      )
      expect(turns).toEqual(['turn-21', 'turn-22', 'turn-23', 'turn-24', 'turn-25'])
      for (let firstReadRows = 1; firstReadRows <= 40; firstReadRows += 1) {
        expect(readIndexedNewestHistoryPage(store, THREAD, turnLimit, firstReadRows)).toEqual(
          expected,
        )
      }
    }
    store.close()
  })

  it('does not trust a tail compaction would leave unchanged', () => {
    const store = newStore()
    const append = (events: DomainEvent[]) =>
      store.appendBatchWithSerializedEvents(events.map((event) => ({ threadId: THREAD, event })))
    // The first turn repeats an item, so the whole log compacts and keeps only
    // the newest turn's diff; no later turn repeats anything.
    append(plainTurn(0))
    for (let index = 1; index < 30; index += 1) {
      const turnId = `turn-${index}`
      append([
        prompt(`prompt-${index}`, turnId),
        started(turnId),
        reply(`reply-${index}`, turnId),
        { type: 'diff.updated', turnId, diff: `diff ${index}` },
        completed(turnId),
      ])
    }

    const expected = expectedPage(store, 3)
    expect(expected.events.filter(({ event }) => event.type === 'diff.updated')).toHaveLength(1)
    for (const firstReadRows of [1, 4, 16]) {
      const page = readIndexedNewestHistoryPage(store, THREAD, 3, firstReadRows)
      if (page) expect(page).toEqual(expected)
    }
    store.close()
  })

  it('stays exact across unreadable rows, restores and retired provider rows', () => {
    const location = fileLocation()
    const store = newStore(location)
    writeSession(store, 7)
    const raw = new DatabaseSync(location)
    const insert = raw.prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, 0, ?)`)
    insert.run(THREAD, '{"type":')
    writeSession(store, 8)
    insert.run(THREAD, '{"type":"item.completed"}')
    raw.close()
    const check = () => {
      for (const turnLimit of [1, 3]) {
        const page = readIndexedNewestHistoryPage(store, THREAD, turnLimit, 4)
        if (page) expect(page).toEqual(expectedPage(store, turnLimit))
      }
    }
    check()

    const middle = store.history(THREAD).at(-120)!.seq
    const token = store.saveRestoreUndo(THREAD, middle, 'checkpoint')
    check()
    store.applyRestoreUndo(THREAD, token)
    check()
    store.saveRestoreUndo(THREAD, middle, 'checkpoint')
    writeSession(store, 9)
    check()

    const provider = (key: string, event: DomainEvent) => ({ key, event })
    // Saved by the provider after the restore, so the merge imports it.
    const savedAt = Date.now() + 1
    expect(
      store.mergeProviderHistory(THREAD, 'one', [
        provider('a', started('provider-1', savedAt)),
        provider('b', reply('provider-reply', 'provider-1')),
        provider('c', completed('provider-1')),
      ]),
    ).toBe(true)
    expect(
      store.mergeProviderHistory(THREAD, 'two', [provider('a', started('provider-1', savedAt))]),
    ).toBe(true)
    for (let index = 100; index < 130; index += 1) {
      store.appendBatchWithSerializedEvents(
        plainTurn(index).map((event) => ({ threadId: THREAD, event })),
      )
    }
    check()
    expect(readIndexedNewestHistoryPage(store, THREAD, 3, 4)).toBeDefined()
    store.close()
  })
})

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

  it.each(['deleted', 'cleaned up'])('forgets a %s thread', (removal) => {
    const store = newStore()
    for (const event of plainTurn(0)) store.append(THREAD, event)
    if (removal === 'deleted') store.deleteThread(THREAD)
    else {
      store.closeThread(THREAD)
      store.pruneHistory(Date.now() + 1, path.join(path.dirname(fileLocation()), 'archive.json'))
    }

    expect(store.historyIndexed(THREAD)).toBe(false)
    expect(store.historyKeyFirstSeqs(THREAD, ['t:turn-0'])).toEqual(new Map())
    expect(store.historyCarryBefore(THREAD, Number.MAX_SAFE_INTEGER)).toEqual({
      approvals: new Map(),
      userInputs: new Map(),
    })
    store.close()
  })
})
