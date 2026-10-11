import { describe, expect, it } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import {
  DEFAULT_HISTORY_PAGE_TURNS,
  InvalidHistoryCursorError,
  decodeHistoryCursor,
  encodeHistoryCursor,
  readHistoryPage,
} from './history-page.js'

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
