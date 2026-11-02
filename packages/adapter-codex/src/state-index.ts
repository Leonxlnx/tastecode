import path from 'node:path'
import type { SQLOutputValue } from 'node:sqlite'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { ProviderHistorySession } from '@harness/contracts'
import { object } from './history-values.js'

/** `internal` is known only when the index records each thread's source. */
export type IndexedSession = { session: ProviderHistorySession; name?: string; internal?: boolean }

/** One state database's threads, kept between listings so a change reads only changed rows. */
export type StateIndex = {
  file: string
  /** The columns read; another schema reads every row again. */
  select: string
  /** Whether rows record their source, which tells internal threads apart. */
  sources: boolean
  /** Each row's entry by thread id; `null` for a row the listing cannot use. */
  byId: Map<string, IndexedSession | null>
  /** Usable entries by their resolved rollout path. */
  byFile: Map<string, IndexedSession>
  rows: number
  /** Archiving moves a rollout without touching updated_at_ms. */
  archived: string
  /** The newest updated_at_ms read; unset when the schema has none, so every change reads all rows. */
  newest?: number
  /** When every row was last read. */
  readAt: number
}

/** `changedFiles` holds the rollout paths whose entries were added, changed or removed. */
export type StateIndexRead = { index: StateIndex | undefined; changedFiles: Set<string> }

type Row = Record<string, SQLOutputValue>
type Database = import('node:sqlite').DatabaseSync

export const PREVIEW_LENGTH = 200
// One statement over an 89 MB index of 6,900 threads took 0.4-1.5 s, all in one
// event-loop turn.
const PAGE_ROWS = 500
// Codex stamps a row before it commits it, and its sessions write concurrently,
// so rows stamped shortly before the newest one seen are read again.
const SKEW_MS = 30_000
// A change that leaves updated_at_ms alone shows up after this long at the latest.
const FULL_READ_MS = 10 * 60_000

/**
 * Reads the first readable state database of `files` (newest schema first). With
 * `previous` from the same database and schema, only rows updated since then are
 * read; a removed or back-dated row, or a changed archive, reads every row again.
 */
export async function readStateIndex(
  home: string,
  files: string[],
  previous: StateIndex | undefined,
): Promise<StateIndexRead> {
  for (const file of files) {
    let db: Database | undefined
    try {
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(path.join(home, file), { readOnly: true })
      // One snapshot for every statement and page below.
      db.exec('BEGIN')
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(threads)')
          .all()
          .map((row) => row.name),
      )
      if (!columns.size) continue
      const select = selectList(columns)
      const stamped = columns.has('updated_at_ms')
      const archived =
        stamped && columns.has('archived')
          ? JSON.stringify(
              db
                .prepare(
                  'SELECT count(*) AS n, total(updated_at_ms) AS t FROM threads WHERE archived = 1',
                )
                .get(),
            )
          : ''
      const rows = Number(db.prepare('SELECT count(*) AS n FROM threads').get()?.n)
      const now = Date.now()
      if (
        previous?.file === file &&
        previous.select === select &&
        previous.newest !== undefined &&
        previous.archived === archived &&
        now - previous.readAt < FULL_READ_MS
      ) {
        const since = Math.min(previous.newest, now) - SKEW_MS
        const changed = db
          .prepare(`SELECT ${select} FROM threads WHERE updated_at_ms >= ?`)
          .all(since)
        const added = changed.filter(
          (row) => typeof row.id === 'string' && !previous.byId.has(row.id),
        ).length
        // Only a removed row, or one stamped before `since`, leaves the count off.
        if (rows === previous.rows + added && changed.every((row) => typeof row.id === 'string'))
          return { index: previous, changedFiles: merge(previous, changed, rows) }
      }
      const index: StateIndex = {
        file,
        select,
        sources: columns.has('source'),
        byId: new Map(),
        byFile: new Map(),
        rows,
        archived,
        readAt: now,
        ...(stamped ? { newest: 0 } : {}),
      }
      for await (const page of pages(db, select)) merge(index, page, rows)
      db.exec('COMMIT')
      return { index, changedFiles: compare(previous, index) }
    } catch {
      /* Older, unavailable, or locked indexes fall back to rollout metadata. */
    } finally {
      db?.close()
    }
  }
  return { index: undefined, changedFiles: new Set(previous?.byFile.keys()) }
}

function selectList(columns: Set<unknown>): string {
  const created = columns.has('created_at_ms')
    ? 'COALESCE(created_at_ms, created_at * 1000)'
    : 'created_at * 1000'
  const updated = columns.has('updated_at_ms')
    ? 'COALESCE(updated_at_ms, updated_at * 1000)'
    : 'updated_at * 1000'
  const name = columns.has('name') ? 'name' : 'NULL'
  const preview = columns.has('preview') ? "COALESCE(NULLIF(preview, ''), title)" : 'title'
  const source = columns.has('source') ? 'source' : 'NULL'
  const stamp = columns.has('updated_at_ms') ? 'updated_at_ms' : 'NULL'
  return `id, rollout_path, cwd, ${name} AS name, substr(${preview}, 1, ${PREVIEW_LENGTH}) AS preview, ${created} AS created, ${updated} AS updated, ${source} AS source, ${stamp} AS stamp`
}

/** Every row, one page per event-loop turn. */
async function* pages(db: Database, select: string): AsyncGenerator<Row[]> {
  let page
  try {
    page = db.prepare(
      `SELECT rowid AS position, ${select} FROM threads WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_ROWS}`,
    )
  } catch {
    // A table without row ids is read in one statement.
    yield db.prepare(`SELECT ${select} FROM threads`).all()
    return
  }
  let after = Number.MIN_SAFE_INTEGER
  for (;;) {
    const rows = page.all(after)
    if (rows.length) yield rows
    if (rows.length < PAGE_ROWS) return
    after = Number(rows.at(-1)!.position)
    await nextTurn()
  }
}

/** Applies `rows` to `index` and returns the rollout paths whose entries changed. */
function merge(index: StateIndex, rows: Row[], count: number): Set<string> {
  const changedFiles = new Set<string>()
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    if (index.newest !== undefined && typeof row.stamp === 'number')
      index.newest = Math.max(index.newest, row.stamp)
    const before = index.byId.get(row.id)
    const after = entry(row, index.sources)
    if (before !== undefined && sameEntry(before, after)) continue
    const beforeFile = before?.session.locator && path.resolve(before.session.locator)
    if (beforeFile && index.byFile.get(beforeFile) === before) {
      index.byFile.delete(beforeFile)
      changedFiles.add(beforeFile)
    }
    index.byId.set(row.id, after)
    if (after) {
      const file = path.resolve(after.session.locator!)
      index.byFile.set(file, after)
      changedFiles.add(file)
    }
  }
  index.rows = count
  return changedFiles
}

/** Keeps the entries of unchanged rows, so their sessions are reused, and names what changed. */
function compare(previous: StateIndex | undefined, next: StateIndex): Set<string> {
  if (previous)
    for (const [id, after] of next.byId) {
      const before = previous.byId.get(id)
      if (!before || !after || !sameEntry(before, after)) continue
      next.byId.set(id, before)
      const file = path.resolve(after.session.locator!)
      if (next.byFile.get(file) === after) next.byFile.set(file, before)
    }
  const changedFiles = new Set<string>()
  for (const file of new Set([...(previous?.byFile.keys() ?? []), ...next.byFile.keys()]))
    if (previous?.byFile.get(file) !== next.byFile.get(file)) changedFiles.add(file)
  return changedFiles
}

function entry(row: Row, sources: boolean): IndexedSession | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.rollout_path !== 'string' ||
    typeof row.cwd !== 'string'
  )
    return null
  return {
    ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name } : {}),
    ...(sources ? { internal: subagentSource(row.source) } : {}),
    session: {
      id: row.id,
      workspacePath: row.cwd,
      title: previewTitle(row.preview),
      createdAt: Number(row.created),
      updatedAt: Number(row.updated),
      revision: String(row.updated),
      locator: row.rollout_path,
    },
  }
}

function sameEntry(a: IndexedSession | null, b: IndexedSession | null): boolean {
  if (!a || !b) return a === b
  return (
    a.name === b.name &&
    a.internal === b.internal &&
    a.session.id === b.session.id &&
    a.session.workspacePath === b.session.workspacePath &&
    a.session.title === b.session.title &&
    a.session.createdAt === b.session.createdAt &&
    a.session.updatedAt === b.session.updatedAt &&
    a.session.locator === b.session.locator
  )
}

/** The index stores a plain label (`cli`) or the rollout's JSON source object. */
function subagentSource(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('{')) return false
  try {
    return 'subagent' in object(JSON.parse(value))
  } catch {
    return false
  }
}

export function previewTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, PREVIEW_LENGTH).replace(/\s+/g, ' ').trim() || 'Codex chat'
    : 'Codex chat'
}
