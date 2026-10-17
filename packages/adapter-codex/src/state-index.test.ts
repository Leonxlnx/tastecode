import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStateIndex, type StateIndex } from './state-index.js'

const roots: string[] = []
const at = Date.parse('2026-10-17T10:00:00.000Z')

// The columns and indexes Codex 0.163 gives state_5.sqlite's threads table, reduced
// to those the history index reads.
const SCHEMA = `
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  preview TEXT NOT NULL DEFAULT '',
  name TEXT
);
CREATE INDEX idx_threads_archived ON threads(archived);
CREATE INDEX idx_threads_updated_at_ms ON threads(updated_at_ms DESC, id DESC);
CREATE INDEX idx_threads_archive_updated_at_ms ON threads(archived, updated_at_ms DESC, id DESC)
  WHERE archived = 1;
`

async function stateStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-state-index-'))
  roots.push(root)
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  const insert = db.prepare(
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title,
       created_at_ms, updated_at_ms, preview, name) VALUES (?, ?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?)`,
  )
  const rollout = (id: string, archived = false) =>
    path.join(root, archived ? 'archived_sessions' : 'sessions', `rollout-${id}.jsonl`)
  const add = (id: string, updated: number, name: string | null = null) =>
    insert.run(
      id,
      rollout(id),
      Math.floor(at / 1000),
      Math.floor(updated / 1000),
      '/project',
      `Prompt ${id}`,
      at,
      updated,
      `Prompt ${id}`,
      name,
    )
  let index: StateIndex | undefined
  const read = async () => {
    const result = await readStateIndex(root, ['state_5.sqlite'], index)
    index = result.index
    return result
  }
  return { root, db, add, rollout, read }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex state index', () => {
  it('reads only rows updated since the last read and keeps unchanged entries', async () => {
    const { db, add, rollout, read } = await stateStore()
    add('one', at)
    add('two', at + 1_000)
    const first = await read()
    const two = first.index!.byId.get('two')
    const prepared = vi.spyOn(DatabaseSync.prototype, 'prepare')

    db.prepare('UPDATE threads SET updated_at_ms = ?, name = ? WHERE id = ?').run(
      at + 60_000,
      'Renamed',
      'one',
    )
    add('three', at + 61_000)
    const second = await read()

    expect(prepared.mock.calls.some(([sql]) => sql.includes('rowid'))).toBe(false)
    expect(second.index).toBe(first.index)
    expect(second.index!.byId.get('one')?.name).toBe('Renamed')
    expect(second.index!.byId.get('three')?.session.locator).toBe(rollout('three'))
    expect(second.index!.byId.get('two')).toBe(two)
    expect(second.changedFiles).toEqual(new Set([rollout('one'), rollout('three')]))
    db.close()
  })

  it('takes rows that commit shortly after a newer row was read', async () => {
    const { db, add, read } = await stateStore()
    add('one', at)
    add('two', at + 10_000)
    await read()
    const prepared = vi.spyOn(DatabaseSync.prototype, 'prepare')

    add('late', at + 5_000)
    db.prepare('UPDATE threads SET updated_at_ms = ?, name = ? WHERE id = ?').run(
      at + 8_000,
      'Renamed',
      'one',
    )
    const { index } = await read()

    expect(prepared.mock.calls.some(([sql]) => sql.includes('rowid'))).toBe(false)
    expect(index!.byId.get('late')?.session.id).toBe('late')
    expect(index!.byId.get('one')?.name).toBe('Renamed')
    db.close()
  })

  it('reads every row again when a row was removed or written with an older stamp', async () => {
    const { db, add, rollout, read } = await stateStore()
    add('one', at)
    add('two', at + 120_000)
    await read()

    db.prepare('DELETE FROM threads WHERE id = ?').run('one')
    const removed = await read()
    expect(removed.index!.byId.has('one')).toBe(false)
    expect(removed.changedFiles).toEqual(new Set([rollout('one')]))

    // Far older than the newest row, so only the row count shows it.
    add('late', at - 600_000)
    const late = await read()
    expect(late.index!.byFile.get(rollout('late'))?.session.id).toBe('late')
    expect(late.changedFiles).toEqual(new Set([rollout('late')]))
    db.close()
  })

  it('notices an archived thread although archiving keeps its update stamp', async () => {
    const { db, add, rollout, read } = await stateStore()
    add('one', at)
    add('two', at + 120_000)
    await read()

    db.prepare(
      'UPDATE threads SET archived = 1, archived_at = ?, rollout_path = ? WHERE id = ?',
    ).run(Math.floor(at / 1000) + 600, rollout('one', true), 'one')
    const archived = await read()

    expect(archived.index!.byFile.has(rollout('one'))).toBe(false)
    expect(archived.index!.byFile.get(rollout('one', true))?.session.id).toBe('one')
    expect(archived.changedFiles).toEqual(new Set([rollout('one'), rollout('one', true)]))
    db.close()
  })

  it('reads every row again after ten minutes to catch changes without a new stamp', async () => {
    const { db, add, read } = await stateStore()
    // Outside the window of recent rows that every read takes again.
    add('one', at - 120_000)
    add('two', at)
    const now = vi.spyOn(Date, 'now').mockReturnValue(at)
    await read()
    db.prepare('UPDATE threads SET preview = ? WHERE id = ?').run('Edited prompt', 'one')

    expect((await read()).index!.byId.get('one')?.session.title).toBe('Prompt one')
    now.mockReturnValue(at + 10 * 60_000)
    expect((await read()).index!.byId.get('one')?.session.title).toBe('Edited prompt')
    db.close()
  })

  it('reads an index without update stamps in full', async () => {
    const legacy = await mkdtemp(path.join(os.tmpdir(), 'codex-state-index-'))
    roots.push(legacy)
    const old = new DatabaseSync(path.join(legacy, 'state_4.sqlite'))
    old.exec(
      'CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER)',
    )
    const insert = old.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('old', path.join(legacy, 'old.jsonl'), '/project', 'Old title', 1, 2)
    const first = await readStateIndex(legacy, ['state_4.sqlite'], undefined)
    expect(first.index?.newest).toBeUndefined()
    old.prepare('UPDATE threads SET title = ?').run('New title')
    const second = await readStateIndex(legacy, ['state_4.sqlite'], first.index)
    expect(second.index!.byId.get('old')?.session.title).toBe('New title')
    old.close()
  })
})
