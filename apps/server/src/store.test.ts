import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
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
