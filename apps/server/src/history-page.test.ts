import { describe, expect, it } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import {
  emptyThread,
  prependCompleteHistory,
  reduceEventLog,
  threadItems,
} from '../../web/src/thread-store.js'
import {
  DEFAULT_HISTORY_PAGE_TURNS,
  InvalidHistoryCursorError,
  decodeHistoryCursor,
  encodeHistoryCursor,
  readHistoryPage,
} from './history-page.js'
import { compactHistoryReplay } from './history-replay.js'

type Entry = { seq: number; event: DomainEvent }

function entries(events: DomainEvent[]): Entry[] {
  return events.map((event, index) => ({ seq: index + 1, event }))
}

const started = (turnId: string): DomainEvent => ({
  type: 'turn.started',
  turn: { id: turnId, threadId: 'thread', status: 'running', createdAt: 0 },
})
const completed = (turnId: string): DomainEvent => ({
  type: 'turn.completed',
  turnId,
  status: 'completed',
})
const message = (id: string, turnId: string, role: 'user' | 'assistant'): DomainEvent => ({
  type: 'item.completed',
  item: { id, turnId, type: 'message', role, status: 'completed', text: id, createdAt: 0 },
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

/** A local turn: the server records the prompt before the provider's start. */
function turn(index: number): DomainEvent[] {
  const id = `turn-${index}`
  return [
    message(`prompt-${index}`, id, 'user'),
    started(id),
    message(`reply-${index}`, id, 'assistant'),
    completed(id),
  ]
}

function pageItemIds(events: readonly Entry[]): string[] {
  return events.flatMap(({ event }) => (event.type === 'item.completed' ? [event.item.id] : []))
}

describe('history pages', () => {
  it('walks back through whole turns until the replay is exhausted', () => {
    const replay = entries([
      {
        type: 'thread.started',
        thread: { id: 'thread', provider: 'codex', workspacePath: '/r', createdAt: 0 },
      },
      ...Array.from({ length: 7 }, (_, index) => turn(index)).flat(),
    ])

    const newest = readHistoryPage('thread', replay, { turnLimit: 3 })
    expect(pageItemIds(newest.events)).toEqual([
      'prompt-4',
      'reply-4',
      'prompt-5',
      'reply-5',
      'prompt-6',
      'reply-6',
    ])
    expect(newest.page.snapshotSeq).toBe(replay.at(-1)!.seq)
    expect(newest.reset).toBeUndefined()

    const pages = [newest.events]
    let cursor = newest.page.olderCursor
    while (cursor !== null) {
      const older = readHistoryPage('thread', replay, {
        before: decodeHistoryCursor('thread', cursor),
        turnLimit: 3,
      })
      expect(older.page.snapshotSeq).toBe(newest.page.snapshotSeq)
      pages.unshift(older.events)
      cursor = older.page.olderCursor
    }

    // Concatenated pages are the replay itself: nothing lost, nothing repeated.
    expect(pages.flat()).toEqual(replay)
    expect(pages.map((page) => pageItemIds(page).length)).toEqual([2, 6, 6])
  })

  it('keeps a turn whose events interleave with the next one in a single block', () => {
    const replay = entries([
      ...turn(0),
      started('turn-1'),
      message('reply-1', 'turn-1', 'assistant'),
      // A late tool completion from turn-1 after turn-2 started.
      started('turn-2'),
      message('late-1', 'turn-1', 'assistant'),
      message('reply-2', 'turn-2', 'assistant'),
      completed('turn-2'),
      ...turn(3),
    ])

    const newest = readHistoryPage('thread', replay, { turnLimit: 2 })
    // turn-3 alone is one turn; the interleaved pair counts as two more, so the
    // page exceeds the requested size rather than splitting them.
    expect(pageItemIds(newest.events)).toEqual([
      'reply-1',
      'late-1',
      'reply-2',
      'prompt-3',
      'reply-3',
    ])
    const older = readHistoryPage('thread', replay, {
      before: decodeHistoryCursor('thread', newest.page.olderCursor!),
    })
    expect(pageItemIds(older.events)).toEqual(['prompt-0', 'reply-0'])
    expect(older.page.olderCursor).toBeNull()
  })

  it('carries unanswered requests and the latest usage into the newest page only', () => {
    const replay = entries([
      ...turn(0),
      {
        type: 'user_input.requested',
        request: {
          id: 'brief',
          turnId: 'turn-0',
          questions: [
            {
              id: 'q',
              header: 'Brief',
              question: 'What?',
              allowOther: true,
              secret: false,
              options: null,
            },
          ],
          autoResolutionMs: null,
          createdAt: 0,
        },
      },
      started('turn-1'),
      {
        type: 'approval.requested',
        request: { id: 'cleared', kind: 'command', command: 'ls', createdAt: 0 },
      },
      completed('turn-1'),
      started('turn-2'),
      {
        type: 'approval.requested',
        request: { id: 'answered', kind: 'command', command: 'ls', createdAt: 0 },
      },
      { type: 'approval.resolved', id: 'answered' },
      usage(42),
      completed('turn-2'),
      ...turn(3),
    ])

    const newest = readHistoryPage('thread', replay, { turnLimit: 1 })
    const carried = newest.events.slice(0, 2).map(({ event }) => event.type)
    expect(carried).toEqual(['user_input.requested', 'usage.updated'])
    expect(newest.events.slice(2)).toEqual(replay.slice(-4))

    const older = readHistoryPage('thread', replay, {
      before: decodeHistoryCursor('thread', newest.page.olderCursor!),
      turnLimit: 1,
    })
    expect(older.events.map(({ event }) => event.type)).toContain('usage.updated')
    expect(older.events[0]!.event.type).toBe('turn.started')
  })

  it('walks back through a replay that sorts imported turns by time', () => {
    const log = entries([
      ...turn(1),
      ...turn(2),
      // Discovered after the local turns, but older than both.
      {
        type: 'turn.started',
        turn: { id: 'import:a', threadId: 'thread', status: 'running', createdAt: -1 },
      },
      message('import-a', 'import:a', 'assistant'),
      completed('import:a'),
    ])
    const replay = compactHistoryReplay(log)

    const pages: Entry[][] = []
    let page = readHistoryPage('thread', replay, { turnLimit: 1 })
    expect(page.page.snapshotSeq).toBe(log.at(-1)!.seq)
    pages.unshift(page.events)
    while (page.page.olderCursor !== null) {
      page = readHistoryPage('thread', replay, {
        before: decodeHistoryCursor('thread', page.page.olderCursor),
        turnLimit: 1,
      })
      pages.unshift(page.events)
    }
    expect(pages.map(pageItemIds)).toEqual([
      ['import-a'],
      ['prompt-1', 'reply-1'],
      ['prompt-2', 'reply-2'],
    ])
    expect(pages.flat()).toEqual(replay)
  })

  it('drops requests a thread error left unanswered', () => {
    const replay = entries([
      ...turn(0),
      started('turn-1'),
      {
        type: 'user_input.requested',
        request: {
          id: 'brief',
          turnId: 'turn-1',
          questions: [
            {
              id: 'q',
              header: 'Brief',
              question: 'What?',
              allowOther: true,
              secret: false,
              options: null,
            },
          ],
          autoResolutionMs: null,
          createdAt: 0,
        },
      },
      {
        type: 'approval.requested',
        request: { id: 'pending', kind: 'command', command: 'ls', createdAt: 0 },
      },
      // A failed Design flow records the error without resolving its question.
      { type: 'thread.error', threadId: 'thread', message: 'Design failed' },
      ...turn(2),
      ...turn(3),
    ])

    const newest = readHistoryPage('thread', replay, { turnLimit: 2 })
    expect(newest.events).toEqual(replay.slice(-8))
  })

  it('restarts from the newest page when a cursor no longer matches the replay', () => {
    const replay = entries(Array.from({ length: 4 }, (_, index) => turn(index)).flat())
    const newest = readHistoryPage('thread', replay, { turnLimit: 1 })
    const cursor = decodeHistoryCursor('thread', newest.page.olderCursor!)

    const stale = readHistoryPage('thread', replay, {
      before: cursor,
      turnLimit: 1,
      isStale: () => true,
    })
    expect(stale.reset).toBe(true)
    expect(stale.events).toEqual(newest.events)
    expect(stale.page).toEqual(newest.page)

    // A restore removed the cursor's turn entirely.
    const truncated = replay.slice(0, 8)
    const missing = readHistoryPage('thread', truncated, { before: cursor, turnLimit: 1 })
    expect(missing.reset).toBe(true)
    expect(pageItemIds(missing.events)).toEqual(['prompt-1', 'reply-1'])
  })

  it('keeps an issued cursor valid while newer turns arrive', () => {
    const replay = entries(Array.from({ length: 3 }, (_, index) => turn(index)).flat())
    const newest = readHistoryPage('thread', replay, { turnLimit: 1 })
    const grown = entries([...replay.map(({ event }) => event), ...turn(3), ...turn(4)])

    const older = readHistoryPage('thread', grown, {
      before: decodeHistoryCursor('thread', newest.page.olderCursor!),
      turnLimit: 1,
    })
    expect(older.reset).toBeUndefined()
    expect(pageItemIds(older.events)).toEqual(['prompt-1', 'reply-1'])
    expect(older.page.snapshotSeq).toBe(grown.at(-1)!.seq)
  })

  it('returns a single complete page for short and empty histories', () => {
    expect(readHistoryPage('thread', [], {})).toEqual({
      events: [],
      page: { olderCursor: null, snapshotSeq: 0 },
    })
    const replay = entries(Array.from({ length: 2 }, (_, index) => turn(index)).flat())
    const page = readHistoryPage('thread', replay, {})
    expect(page.events).toEqual(replay)
    expect(page.page.olderCursor).toBeNull()
    expect(DEFAULT_HISTORY_PAGE_TURNS).toBeGreaterThan(2)
  })

  it('rejects malformed and cross-thread cursors', () => {
    const cursor = encodeHistoryCursor('thread', { seq: 4, turnHash: 'abc' })
    expect(decodeHistoryCursor('thread', cursor)).toEqual({ seq: 4, turnHash: 'abc' })
    expect(() => decodeHistoryCursor('other-thread', cursor)).toThrow(InvalidHistoryCursorError)
    expect(() => decodeHistoryCursor('thread', 'not-json')).toThrow(InvalidHistoryCursorError)
    const negative = Buffer.from(JSON.stringify({ v: 1, t: 'x', s: -1, k: 'a' })).toString(
      'base64url',
    )
    expect(() => decodeHistoryCursor('thread', negative)).toThrow(InvalidHistoryCursorError)
  })

  it('keeps cursors within the protocol limit for very long turn ids', () => {
    const longId = `import:${'x'.repeat(2_000)}`
    const replay = entries([...turn(0), started(longId), completed(longId), ...turn(2)])
    const page = readHistoryPage(`thread-${'y'.repeat(600)}`, replay, { turnLimit: 1 })
    expect(page.page.olderCursor!.length).toBeLessThanOrEqual(512)
  })
})

/** A small deterministic generator, so a failing history can be replayed by seed. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

const question = {
  id: 'q',
  header: 'Brief',
  question: 'What should it look like?',
  allowOther: true,
  secret: false,
  options: null,
}

/**
 * Turns as providers record them: prompts before or after the turn start,
 * streamed replies, plans and diffs with and without a turn, approvals and
 * questions answered later or never, usage, imported turns that predate local
 * ones, interrupted turns and thread errors that end a turn without settling it.
 */
function randomHistory(seed: number): DomainEvent[] {
  const next = random(seed)
  const chance = (p: number) => next() < p
  const events: DomainEvent[] = []
  const openInputs: string[] = []
  const openApprovals: string[] = []
  const turns = 2 + Math.floor(next() * 14)
  for (let index = 0; index < turns; index += 1) {
    const imported = chance(0.15)
    const turnId = imported ? `import:${index}` : `turn-${index}`
    const at = imported ? Math.floor(next() * 50) : 100 + index
    const prompt: Item = {
      id: `prompt-${index}`,
      turnId,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: `Prompt ${index}`,
      createdAt: at,
    }
    const early = chance(0.4)
    if (early) events.push({ type: 'item.completed', item: prompt })
    events.push({
      type: 'turn.started',
      turn: { id: turnId, threadId: 'thread', status: 'running', createdAt: at },
    })
    if (!early) events.push({ type: 'item.completed', item: prompt })
    const reply: Item = {
      id: `reply-${index}`,
      turnId,
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: '',
      createdAt: at,
    }
    events.push({ type: 'item.started', item: reply })
    for (let part = 0; part < 1 + Math.floor(next() * 3); part += 1) {
      events.push({ type: 'item.delta', turnId, itemId: reply.id, textDelta: `${part} ` })
    }
    if (chance(0.4)) {
      events.push({
        type: 'plan.updated',
        ...(chance(0.5) ? { turnId } : {}),
        steps: [{ text: `Plan ${index}`, status: 'running' }],
      })
    }
    if (chance(0.4)) {
      events.push({ type: 'diff.updated', ...(chance(0.5) ? { turnId } : {}), diff: `d${index}` })
    }
    if (chance(0.3)) {
      const id = `approval-${index}`
      events.push({
        type: 'approval.requested',
        request: { id, kind: 'command', command: 'ls', createdAt: at },
      })
      openApprovals.push(id)
    }
    if (chance(0.25)) {
      const id = `input-${index}`
      events.push({
        type: 'user_input.requested',
        request: { id, turnId, questions: [question], autoResolutionMs: null, createdAt: at },
      })
      openInputs.push(id)
    }
    if (openApprovals.length > 0 && chance(0.4)) {
      events.push({ type: 'approval.resolved', id: openApprovals.shift()! })
    }
    if (openInputs.length > 0 && chance(0.3)) {
      events.push({ type: 'user_input.resolved', id: openInputs.shift()! })
    }
    if (chance(0.5)) events.push(usage(index + 1))
    const ending = next()
    if (ending < 0.1) {
      events.push({ type: 'thread.error', threadId: 'thread', message: `Failed ${index}` })
      openApprovals.length = 0
      openInputs.length = 0
    } else if (ending > 0.15) {
      events.push({ type: 'item.completed', item: { ...reply, status: 'completed', text: 'done' } })
      events.push({ type: 'turn.completed', turnId, status: 'completed', completedAt: at + 1 })
      openApprovals.length = 0
    }
  }
  return events
}

/** What the renderer shows outside the loaded rows, plus the rows themselves. */
function rendered(events: ReadonlyArray<{ event: DomainEvent }>) {
  const state = reduceEventLog(emptyThread, events)
  return {
    usage: state.usage,
    approvals: state.approvals.map(({ id }) => id),
    userInputs: state.userInputs.map(({ id }) => id),
    plan: state.plan,
    diff: state.diff,
    diffTurnId: state.diffTurnId,
    error: state.error?.message,
    rows: threadItems(state).map((row) => ({
      // Thread error rows are numbered by position and stamped with the clock.
      id: row.type === 'error' ? 'error' : row.id,
      status: row.status,
      text: row.text,
    })),
  }
}

describe('history pages against the renderer', () => {
  it('completes a newest page that starts with a turn that failed before any item', () => {
    const replay = compactHistoryReplay(
      entries([
        ...turn(0),
        started('turn-1'),
        { type: 'thread.error', threadId: 'thread', message: 'Provider exited' },
        ...turn(2),
        ...turn(3),
      ]),
    )
    const newest = readHistoryPage('thread', replay, { turnLimit: 3 })
    const loaded = {
      ...reduceEventLog(emptyThread, newest.events),
      olderCursor: newest.page.olderCursor!,
    }
    expect(threadItems(loaded)[0]?.type).toBe('error')

    const completed = prependCompleteHistory(loaded, replay)
    // Error rows get a fresh renderer-local id on every replay.
    const rows = (state: typeof loaded) =>
      threadItems(state).map(({ id, type, text }) => ({
        id: type === 'error' ? 'error' : id,
        text,
      }))
    expect(completed && rows(completed)).toEqual(rows(reduceEventLog(emptyThread, replay)))
    expect(completed?.olderCursor).toBeUndefined()
  })

  it('opens to the same thread state from the newest page as from the whole replay', () => {
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const replay = compactHistoryReplay(entries(randomHistory(seed)))
      const full = rendered(replay)
      for (const turnLimit of [1, 2, 3, 5]) {
        const newest = rendered(readHistoryPage('thread', replay, { turnLimit }).events)
        const context = `seed ${seed}, ${turnLimit} turns`
        expect({ ...newest, rows: undefined }, context).toEqual({ ...full, rows: undefined })
        expect(newest.rows, context).toEqual(full.rows.slice(full.rows.length - newest.rows.length))
      }
    }
  })
})
