import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { Store } from './store.js'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

const message = (text: string): DomainEvent => ({
  type: 'item.completed',
  item: {
    id: `i-${text}`,
    turnId: 't1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  },
})

const usage = (totalTokens: number, costUsd?: number): DomainEvent => ({
  type: 'usage.updated',
  usage: {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  },
})

describe('opening a database written by an older build', () => {
  /**
   * The break this guards against only ever hits people who used the app
   * before the change, so it cannot show up in development — a fresh database
   * always has every column.
   */
  it('adds columns that did not exist yet instead of failing every query', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-store-'))
    const file = path.join(dir, 'old.db')

    // Exactly the shape shipped before worktrees and pinning existed.
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
        agent TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        at INTEGER NOT NULL, payload TEXT NOT NULL);
    `)
    old.prepare(`INSERT INTO projects VALUES (?, ?, ?)`).run('/repo', 'Old project', 1)
    old
      .prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('t1', '/repo', 'codex', null, 'Old session', 1, null)
    old
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
      .run('t1', 2, JSON.stringify(message('legacy regression')))
    old.close()

    const migrated = new Store(file)
    try {
      // The old rows survive, and the new columns answer rather than throw.
      expect(migrated.project('/repo')?.name).toBe('Old project')
      expect(migrated.project('/repo')?.pinned).toBe(false)
      expect(migrated.thread('t1')?.title).toBe('Old session')
      expect(migrated.thread('t1')?.worktreePath).toBeUndefined()

      migrated.setPinned('/repo', true)
      expect(migrated.project('/repo')?.pinned).toBe(true)
      expect(migrated.searchSessions({ query: 'legacy' }).results[0]?.threadId).toBe('t1')
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('projects', () => {
  it('names a project after its folder when no name is given', () => {
    const project = store.addProject('/home/me/work/harness')
    expect(project.name).toBe('harness')
  })

  it('does not overwrite a name when the same project is added again', () => {
    store.addProject('/repo')
    store.renameProject('/repo', 'My thing')
    store.addProject('/repo')

    // Adding a folder twice is a normal thing to do, and it must not silently
    // undo the name the user chose.
    expect(store.project('/repo')?.name).toBe('My thing')
  })

  it('removes a project together with its threads, events and checkpoints', () => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('t1', message('hello'))
    store.addCheckpoint({ threadId: 't1', seq: 1, commit: 'abc', label: 'a turn' })

    store.removeProject('/repo')

    expect(store.project('/repo')).toBeUndefined()
    expect(store.thread('t1')).toBeUndefined()
    expect(store.history('t1')).toEqual([])
    // Rows nothing points at any more are a leak that grows with use.
    expect(store.checkpoints('t1')).toEqual([])
  })
})

describe('threads', () => {
  beforeEach(() => {
    store.addProject('/repo')
  })

  it('keeps the ACP agent, because the provider alone cannot start the session', () => {
    store.addThread({
      id: 't1',
      projectPath: '/repo',
      provider: 'acp',
      agent: 'gemini',
      title: 'One',
    })
    expect(store.thread('t1')?.agent).toBe('gemini')
  })

  it('leaves the agent unset for providers that are a single engine', () => {
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    expect(store.thread('t1')?.agent).toBeUndefined()
  })

  it('refuses to forget an isolated checkout before it is discarded', () => {
    store.addThread({
      id: 'isolated',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Isolated',
      worktreePath: '/trees/isolated',
      worktreeBranch: 'harness/isolated',
    })

    expect(() => store.deleteThread('isolated')).toThrow('discard the isolated session checkout')
    expect(() => store.removeProject('/repo')).toThrow('discard isolated session checkouts')
    expect(store.thread('isolated')).toBeDefined()
  })

  it('lists newest first', () => {
    store.addThread({
      id: 'old',
      projectPath: '/repo',
      provider: 'codex',
      title: 'Old',
      createdAt: 1000,
    })
    store.addThread({
      id: 'new',
      projectPath: '/repo',
      provider: 'codex',
      title: 'New',
      createdAt: 2000,
    })

    expect(store.threads('/repo').map((t) => t.id)).toEqual(['new', 'old'])
  })

  it('keeps a closed session rather than discarding it', () => {
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
    store.append('t1', message('hello'))

    store.closeThread('t1')

    // Ending the process is not the same as wanting the transcript gone.
    expect(store.thread('t1')?.closedAt).toBeGreaterThan(0)
    expect(store.history('t1')).toHaveLength(1)
  })

  it('separates threads by project', () => {
    store.addProject('/other')
    store.addThread({ id: 'a', projectPath: '/repo', provider: 'codex', title: 'A' })
    store.addThread({ id: 'b', projectPath: '/other', provider: 'codex', title: 'B' })

    expect(store.threads('/repo').map((t) => t.id)).toEqual(['a'])
    expect(
      store
        .threads()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })
})

describe('events', () => {
  beforeEach(() => {
    store.addProject('/repo')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'One' })
  })

  it('replays a thread in the order it happened', () => {
    store.append('t1', message('one'))
    store.append('t1', message('two'))
    store.append('t1', message('three'))

    const texts = store.history('t1').map((entry) => {
      const event = entry.event
      return event.type === 'item.completed' ? event.item.text : undefined
    })
    expect(texts).toEqual(['one', 'two', 'three'])
  })

  it('returns only what happened after a sequence number', () => {
    store.append('t1', message('one'))
    const seq = store.append('t1', message('two'))
    store.append('t1', message('three'))

    // A client that fell behind asks for the tail; the same call serves both.
    const tail = store.history('t1', seq)
    expect(tail).toHaveLength(1)
    const event = tail[0]?.event
    expect(event?.type === 'item.completed' ? event.item.text : undefined).toBe('three')
  })

  it('never hands one thread another thread events', () => {
    store.addThread({ id: 't2', projectPath: '/repo', provider: 'codex', title: 'Two' })
    store.append('t1', message('mine'))
    store.append('t2', message('theirs'))

    expect(store.history('t1')).toHaveLength(1)
    expect(store.history('t2')).toHaveLength(1)
  })

  it('reports zero for a thread that has produced nothing', () => {
    expect(store.lastSeq('t1')).toBe(0)
  })

  it('survives an event carrying text that would break naive escaping', () => {
    const nasty = 'quote " backslash \\ newline \n null-ish \\u0000 emoji 🙂'
    store.append('t1', message(nasty))

    const event = store.history('t1')[0]?.event
    expect(event?.type === 'item.completed' ? event.item.text : undefined).toBe(nasty)
  })
})

describe('cross-session search', () => {
  beforeEach(() => {
    store.addProject('/repo', 'Harness')
    store.addThread({ id: 't1', projectPath: '/repo', provider: 'codex', title: 'Search work' })
  })

  it('indexes messages and useful tool output but not reasoning', () => {
    store.append('t1', message('Find the regression'))
    store.append('t1', {
      type: 'item.completed',
      item: {
        id: 'command',
        turnId: 't2',
        type: 'command',
        status: 'completed',
        command: 'pnpm test',
        text: 'regression suite passed',
        createdAt: 2,
      },
    })
    store.append('t1', {
      type: 'item.completed',
      item: {
        id: 'reasoning',
        turnId: 't3',
        type: 'reasoning',
        status: 'completed',
        text: 'private-thought-marker',
        createdAt: 3,
      },
    })

    expect(store.searchSessions({ query: 'regression' }).results).toHaveLength(2)
    expect(store.searchSessions({ query: 'pnpm' }).results[0]?.turnId).toBe('t2')
    expect(store.searchSessions({ query: 'private-thought-marker' }).results).toEqual([])
  })

  it('filters and paginates without repeating results', () => {
    store.addProject('/other', 'Other')
    store.addThread({
      id: 't2',
      projectPath: '/other',
      provider: 'claude-code',
      title: 'Other work',
    })
    store.append('t1', message('shared marker'))
    store.append('t2', message('shared marker'))

    expect(store.searchSessions({ query: 'shared', provider: 'codex' }).results[0]?.threadId).toBe(
      't1',
    )
    expect(
      store.searchSessions({ query: 'shared', projectPath: '/other' }).results[0]?.threadId,
    ).toBe('t2')

    const first = store.searchSessions({ query: 'shared', limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    const second = store.searchSessions({ query: 'shared', limit: 1, cursor: first.nextCursor! })
    expect(second.results[0]?.threadId).not.toBe(first.results[0]?.threadId)
    expect(second.nextCursor).toBeNull()
  })

  it('keeps rollback, undo and deletion consistent with the index', () => {
    const keepSeq = store.append('t1', message('keep this result'))
    store.append('t1', message('temporary marker'))

    const undo = store.saveRestoreUndo('t1', keepSeq, 'snapshot')
    expect(store.searchSessions({ query: 'temporary' }).results).toEqual([])
    store.applyRestoreUndo('t1', undo)
    expect(store.searchSessions({ query: 'temporary' }).results).toHaveLength(1)

    store.deleteThread('t1')
    expect(store.searchSessions({ query: 'temporary' }).results).toEqual([])
  })

  it('returns structured plain-text highlights without adding HTML', () => {
    const dangerous = '<img src=x onerror=alert(1)> regression'
    store.append('t1', message(dangerous))

    const snippet = store.searchSessions({ query: 'regression' }).results[0]!.snippet
    expect(snippet.map((part) => part.text).join('')).toContain(dangerous)
    expect(snippet).toContainEqual({ text: 'regression', highlighted: true })
    expect(snippet.map((part) => part.text).join('')).not.toContain('<mark>')
  })
})

describe('usage totals', () => {
  it('turns cumulative Codex updates into session and daily increments', () => {
    vi.useFakeTimers()
    try {
      store.addProject('/repo')
      store.addThread({ id: 'one', projectPath: '/repo', provider: 'codex', title: 'One' })
      store.addThread({ id: 'two', projectPath: '/repo', provider: 'codex', title: 'Two' })
      vi.setSystemTime(new Date('2026-07-30T23:50:00'))
      store.append('one', usage(100))
      vi.setSystemTime(new Date('2026-07-31T00:10:00'))
      store.append('one', usage(140))
      store.append('two', usage(50))

      expect(store.usageSummary('one', new Date('2026-07-31T00:00:00').getTime())).toEqual({
        session: expect.objectContaining({ totalTokens: 140 }),
        today: expect.objectContaining({ totalTokens: 90 }),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('adds per-turn Claude usage and provider-reported cost', () => {
    store.addProject('/repo')
    store.addThread({ id: 'one', projectPath: '/repo', provider: 'claude-code', title: 'One' })
    store.addThread({ id: 'two', projectPath: '/repo', provider: 'claude-code', title: 'Two' })
    store.append('one', usage(10, 0.02))
    store.append('one', usage(20, 0.03))
    store.append('two', usage(40, 0.04))

    expect(store.usageSummary('one', 0)).toEqual({
      session: expect.objectContaining({ totalTokens: 30, costUsd: 0.05 }),
      today: expect.objectContaining({ totalTokens: 70, costUsd: 0.09 }),
    })
  })
})
