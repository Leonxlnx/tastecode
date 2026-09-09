import { describe, expect, it } from 'vitest'
import {
  hasWorkspaceStartForPath,
  indexQueueItemIdsForChecks,
  indexWorkspaceSessions,
  ThreadOwnedMap,
  workspaceProjectActivity,
} from './workspace-idle.js'

describe('thread-owned map', () => {
  it('keeps thread lookups exact across updates and deletes', () => {
    const rows = new ThreadOwnedMap<{ threadId: string; token: number }>()
    rows.set('a', { threadId: 'thread-1', token: 1 })
    rows.set('b', { threadId: 'thread-2', token: 2 })
    rows.set('c', { threadId: 'thread-1', token: 3 })

    expect(rows.countForThread('thread-1')).toBe(2)
    expect(rows.countForThread('missing')).toBe(0)

    expect([...rows.entriesForThread('thread-1')]).toEqual([
      ['a', { threadId: 'thread-1', token: 1 }],
      ['c', { threadId: 'thread-1', token: 3 }],
    ])

    rows.set('a', { threadId: 'thread-2', token: 4 })
    expect(rows.countForThread('thread-1')).toBe(1)
    expect(rows.countForThread('thread-2')).toBe(2)
    expect([...rows.entriesForThread('thread-1')]).toEqual([
      ['c', { threadId: 'thread-1', token: 3 }],
    ])
    expect([...rows.entriesForThread('thread-2')]).toEqual([
      ['b', { threadId: 'thread-2', token: 2 }],
      ['a', { threadId: 'thread-2', token: 4 }],
    ])

    for (const [id] of rows.entriesForThread('thread-2')) rows.delete(id)
    expect(rows.size).toBe(1)
    expect(rows.countForThread('thread-2')).toBe(0)
    expect([...rows.entriesForThread('thread-2')]).toEqual([])
    expect([...rows]).toEqual([['c', { threadId: 'thread-1', token: 3 }]])
  })
})

describe('queue item membership index', () => {
  const items = Array.from({ length: 32 }, (_, index) => ({ id: `queue-${index}` }))

  it('keeps normal queue checks allocation-free', () => {
    expect(indexQueueItemIdsForChecks(items, 1)).toBeUndefined()
    expect(indexQueueItemIdsForChecks(items.slice(0, 8), 16)).toBeUndefined()
  })

  it('indexes queues before repeated large reconciliation scans', () => {
    const index = indexQueueItemIdsForChecks(items, 16)
    expect(index?.has('queue-31')).toBe(true)
    expect(index?.has('missing')).toBe(false)
  })
})

describe('workspace session index', () => {
  it('locates sessions and keeps the first duplicate', () => {
    const first = { id: 'thread-1', running: false }
    const index = indexWorkspaceSessions([
      { path: '/first', sessions: [first] },
      { path: '/second', sessions: [{ id: 'thread-1', running: true }] },
    ])

    expect(index.get('thread-1')).toEqual({ path: '/first', session: first })
    expect(index.get('missing')).toBeUndefined()
  })
})

describe('pending workspace starts', () => {
  it('checks an iterable directly without materializing it', () => {
    const starts = new Map([
      ['one', { path: '/one' }],
      ['two', { path: '/two' }],
    ])

    expect(hasWorkspaceStartForPath(starts.values(), '/two')).toBe(true)
    expect(hasWorkspaceStartForPath(starts.values(), '/missing')).toBe(false)
    expect(hasWorkspaceStartForPath(starts.values(), undefined)).toBe(false)
  })
})

describe('workspace project activity', () => {
  it('combines live, durable, local, and uncertain work', () => {
    const activity = workspaceProjectActivity(
      [
        { id: 'working', running: true, status: 'working' },
        { id: 'queued', running: false, status: 'queued' },
        { id: 'local-queue', running: false, status: 'idle' },
        { id: 'unknown', running: false, status: 'idle' },
      ],
      new Map([['local-queue', { items: [{}] }]]),
      new Set(['unknown']),
      [],
    )

    expect(activity).toEqual({ running: true, queued: true, unknown: true, needsResync: true })
  })

  it('counts only this project actions and resyncs an unconfirmed one', () => {
    const activity = workspaceProjectActivity(
      [{ id: 'thread-1', running: false, status: 'idle' }],
      new Map(),
      new Set(),
      [
        { threadId: 'another-project', pending: 0 },
        { threadId: 'thread-1', pending: 0 },
      ],
    )

    expect(activity).toEqual({ running: false, queued: true, unknown: false, needsResync: true })
  })

  it('reports an idle project without allocating action subsets', () => {
    expect(
      workspaceProjectActivity(
        [{ id: 'thread-1', running: false, status: 'idle' }],
        new Map(),
        new Set(),
        [{ threadId: 'another-project', pending: 0 }],
      ),
    ).toEqual({ running: false, queued: false, unknown: false, needsResync: false })
  })
})
