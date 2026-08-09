import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  DiffDecision,
  DomainEvent,
  PairedDevice,
  ProviderId,
  SidebarSettings,
  SessionSearchResult,
  ThreadLifecycle,
  Usage,
} from '@harness/contracts'

/**
 * Everything that has to survive a restart.
 *
 * Projects and sessions lived in the renderer's localStorage while the shell
 * was being designed. That made a session something a page reload could
 * destroy, and left a crash with nothing to recover from. The server owns them
 * now, and the renderer holds no durable state of its own.
 *
 * A thread is stored as its event log rather than as a rendered result. The
 * events are already the source of truth at runtime — persisting anything else
 * would mean maintaining a second description of the same thing and keeping
 * the two in agreement.
 *
 * `node:sqlite` rather than a native driver: we ship to Windows and macOS, and
 * a package needing node-gyp is a build failure waiting for whichever of us has
 * the wrong toolchain that week. It is marked experimental in Node 22, so the
 * API surface used here is deliberately small — `exec`, `prepare`, `run`, `all`
 * — and everything goes through this file, so replacing it is one file's work.
 */

export type StoredProject = {
  path: string
  name: string
  /** Pinned to the top of the rail. A choice the user made, so it persists. */
  pinned: boolean
  createdAt: number
}

export type StoredThread = {
  id: string
  projectPath: string
  provider: ProviderId
  /** Which ACP agent, when the provider is `acp`. */
  agent?: string | undefined
  title: string
  pinned: boolean
  createdAt: number
  /** Set when the session was closed. Kept, not deleted — history outlives use. */
  closedAt?: number | undefined
  /**
   * The private checkout this session works in, when it was isolated. Stored
   * because a crash must not orphan a directory nobody remembers creating.
   */
  worktreePath?: string | undefined
  worktreeBranch?: string | undefined
  lifecycle: ThreadLifecycle
  unread: boolean
  lastActiveAt: number
}

export type StoredCheckpoint = {
  id: number
  threadId: string
  /** Where in the conversation this belongs, so both halves roll back together. */
  seq: number
  /** An unreferenced git commit holding the working tree. */
  commit: string
  label: string
  createdAt: number
}

export type StoredUsageEvent = {
  threadId: string
  provider: ProviderId
  at: number
  usage: Usage
}

export type SessionSearchOptions = {
  query: string
  projectPath?: string | undefined
  provider?: ProviderId | undefined
  cursor?: string | undefined
  limit?: number | undefined
}

export type SessionSearchPage = {
  results: SessionSearchResult[]
  nextCursor: string | null
}

type SearchCursor = { score: number; createdAt: number; rowid: number }

const SNIPPET_START = '\u0001'
const SNIPPET_END = '\u0002'
const SEARCH_INDEX_VERSION = 'session_search_v1'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  path       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  provider     TEXT NOT NULL,
  agent        TEXT,
  title        TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  worktree_path   TEXT,
  worktree_branch TEXT,
  lifecycle_state  TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'settled', 'snoozed')),
  lifecycle_at     INTEGER,
  lifecycle_reason TEXT,
  wake_at          INTEGER,
  keep_active      INTEGER NOT NULL DEFAULT 0,
  woke_at          INTEGER,
  unread           INTEGER NOT NULL DEFAULT 0,
  last_active_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sidebar_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mode             TEXT NOT NULL CHECK (mode IN ('classic', 'inbox')),
  auto_settle_days INTEGER CHECK (auto_settle_days BETWEEN 1 AND 90)
);

INSERT OR IGNORE INTO sidebar_settings (id, mode, auto_settle_days) VALUES (1, 'inbox', 3);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_undos (
  token            TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL UNIQUE,
  checkpoint_seq   INTEGER NOT NULL,
  snapshot_commit  TEXT NOT NULL,
  events_json      TEXT NOT NULL,
  checkpoints_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5 (
  thread_id UNINDEXED,
  event_seq UNINDEXED,
  turn_id UNINDEXED,
  created_at UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS diff_decisions (
  thread_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision  TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  PRIMARY KEY (thread_id, target_id)
);

CREATE TABLE IF NOT EXISTS design_runs (
  thread_id TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paired_devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS checkpoints_by_thread ON checkpoints (thread_id, seq);
CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread_id, seq);
CREATE INDEX IF NOT EXISTS threads_by_project ON threads (project_path);
`

/**
 * Columns added after a version shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a database written by an older build keeps its old shape and every query
 * naming a new column fails. Anyone who had used the app before the change
 * would meet that, and only them — which is the kind of break that never shows
 * up in development.
 *
 * Add here as well as to the schema above: the schema is for a fresh database,
 * this is for every existing one.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: 'projects', column: 'pinned', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'threads', column: 'pinned', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'threads', column: 'worktree_path', definition: 'TEXT' },
  { table: 'threads', column: 'worktree_branch', definition: 'TEXT' },
  {
    table: 'threads',
    column: 'lifecycle_state',
    definition: `TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'settled', 'snoozed'))`,
  },
  { table: 'threads', column: 'lifecycle_at', definition: 'INTEGER' },
  { table: 'threads', column: 'lifecycle_reason', definition: 'TEXT' },
  { table: 'threads', column: 'wake_at', definition: 'INTEGER' },
  { table: 'threads', column: 'keep_active', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'threads', column: 'woke_at', definition: 'INTEGER' },
  { table: 'threads', column: 'unread', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'threads', column: 'last_active_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
]

export class Store {
  #db: DatabaseSync
  #insertEvent: StatementSync
  #insertSearchEntry: StatementSync

  /** `:memory:` in tests; a file under the user's data directory in the app. */
  constructor(location: string) {
    if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true })
    this.#db = new DatabaseSync(location)
    // Without WAL a reader blocks a writer, and we do both on every turn.
    this.#db.exec('PRAGMA journal_mode = WAL')
    // FULL fsyncs the WAL on every commit — and append() commits per streamed
    // delta chunk. NORMAL only syncs at checkpoint; with WAL a crash can lose
    // the tail of the log but cannot corrupt the database, which is the right
    // trade for a local event log rebuilt from the agent on resume.
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(SCHEMA)
    // These statements run for every persisted event. Preparing them once
    // keeps SQLite compilation off the streamed-delta path.
    this.#insertEvent = this.#db.prepare(
      `INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`,
    )
    this.#insertSearchEntry = this.#db.prepare(
      `INSERT INTO session_search (rowid, thread_id, event_seq, turn_id, created_at, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    this.#migrate()
    const searchIndexReady = this.#db
      .prepare(`SELECT 1 FROM schema_migrations WHERE name = ?`)
      .get(SEARCH_INDEX_VERSION)
    if (!searchIndexReady) this.#rebuildSearchIndex()
  }

  /** Bring a database written by an older build up to the current shape. */
  #migrate(): void {
    for (const { table, column, definition } of ADDED_COLUMNS) {
      const columns = this.#db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String((row as { name: unknown }).name))
      if (columns.includes(column)) continue
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.#db.exec(`UPDATE threads SET last_active_at = created_at WHERE last_active_at = 0`)
  }

  close(): void {
    this.#db.close()
  }

  // ---- mobile connections -----------------------------------------------

  mobileAccessEnabled(): boolean {
    const row = this.#db
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get('mobile_access_enabled') as { value: string } | undefined
    return row?.value === 'true'
  }

  setMobileAccessEnabled(enabled: boolean): void {
    this.#db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run('mobile_access_enabled', String(enabled))
  }

  pairDevice(name: string, tokenHash: string, at = Date.now()): PairedDevice {
    const device: PairedDevice = {
      id: randomUUID(),
      name,
      createdAt: at,
      lastSeenAt: at,
    }
    this.#db
      .prepare(
        `INSERT INTO paired_devices (id, name, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(device.id, device.name, tokenHash, device.createdAt, device.lastSeenAt)
    return device
  }

  pairedDevices(): PairedDevice[] {
    return this.#db
      .prepare(`SELECT id, name, created_at, last_seen_at FROM paired_devices ORDER BY created_at`)
      .all()
      .map(toPairedDevice)
  }

  hasPairedDevice(id: string): boolean {
    return this.#db.prepare(`SELECT 1 FROM paired_devices WHERE id = ?`).get(id) !== undefined
  }

  pairedDeviceForTokenHash(tokenHash: string): PairedDevice | undefined {
    const row = this.#db
      .prepare(`SELECT id, name, created_at, last_seen_at FROM paired_devices WHERE token_hash = ?`)
      .get(tokenHash)
    return row ? toPairedDevice(row) : undefined
  }

  touchPairedDevice(id: string, at = Date.now()): void {
    this.#db.prepare(`UPDATE paired_devices SET last_seen_at = ? WHERE id = ?`).run(at, id)
  }

  revokePairedDevice(id: string): void {
    this.#db.prepare(`DELETE FROM paired_devices WHERE id = ?`).run(id)
  }

  // ---- projects ----------------------------------------------------------

  addProject(projectPath: string, name?: string): StoredProject {
    const project: StoredProject = {
      path: projectPath,
      name: name ?? path.basename(projectPath),
      pinned: false,
      createdAt: Date.now(),
    }
    // Adding a project twice is a normal thing for a user to do; it must not
    // wipe the name they gave it.
    this.#db
      .prepare(
        `INSERT INTO projects (path, name, pinned, created_at) VALUES (?, ?, 0, ?)
         ON CONFLICT (path) DO NOTHING`,
      )
      .run(project.path, project.name, project.createdAt)
    return this.project(projectPath) ?? project
  }

  setPinned(projectPath: string, pinned: boolean): void {
    this.#db
      .prepare(`UPDATE projects SET pinned = ? WHERE path = ?`)
      .run(pinned ? 1 : 0, projectPath)
  }

  project(projectPath: string): StoredProject | undefined {
    const row = this.#db.prepare(`SELECT * FROM projects WHERE path = ?`).get(projectPath)
    return row ? toProject(row) : undefined
  }

  projects(): StoredProject[] {
    return this.#db.prepare(`SELECT * FROM projects ORDER BY created_at`).all().map(toProject)
  }

  renameProject(projectPath: string, name: string): void {
    this.#db.prepare(`UPDATE projects SET name = ? WHERE path = ?`).run(name, projectPath)
  }

  /** Hides the project from the sidebar. Re-adding it restores its chat history. */
  removeProject(projectPath: string): void {
    this.#db.prepare(`DELETE FROM projects WHERE path = ?`).run(projectPath)
  }

  // ---- threads -----------------------------------------------------------

  addThread(
    thread: Omit<StoredThread, 'createdAt' | 'pinned' | 'lifecycle' | 'unread' | 'lastActiveAt'> & {
      createdAt?: number
    },
  ): StoredThread {
    const stored = { ...thread, createdAt: thread.createdAt ?? Date.now() }
    const lifecycle = { state: 'active', keepActive: false } as const
    this.#db
      .prepare(
        `INSERT INTO threads
           (id, project_path, provider, agent, title, created_at, worktree_path, worktree_branch,
            lifecycle_state, keep_active, unread, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?)`,
      )
      .run(
        stored.id,
        stored.projectPath,
        stored.provider,
        stored.agent ?? null,
        stored.title,
        stored.createdAt,
        stored.worktreePath ?? null,
        stored.worktreeBranch ?? null,
        stored.createdAt,
      )
    return { ...stored, pinned: false, lifecycle, unread: false, lastActiveAt: stored.createdAt }
  }

  /**
   * Every worktree we ever created and have not forgotten.
   *
   * Read at startup: a crash leaves directories behind that nobody remembers,
   * and the record here is the only thing that knows they exist.
   */
  worktrees(): Array<{ threadId: string; path: string; branch: string; repoPath: string }> {
    return this.#db
      .prepare(
        `SELECT id, project_path, worktree_path, worktree_branch FROM threads
                WHERE worktree_path IS NOT NULL`,
      )
      .all()
      .map((row) => {
        const r = row as {
          id: string
          project_path: string
          worktree_path: string
          worktree_branch: string
        }
        return {
          threadId: r.id,
          path: r.worktree_path,
          branch: r.worktree_branch,
          repoPath: r.project_path,
        }
      })
  }

  forgetWorktree(threadId: string): void {
    this.#db
      .prepare(`UPDATE threads SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?`)
      .run(threadId)
  }

  thread(id: string): StoredThread | undefined {
    const row = this.#db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id)
    return row ? toThread(row) : undefined
  }

  /** Newest first — the rail shows recent work at the top. */
  threads(projectPath?: string): StoredThread[] {
    const rows = projectPath
      ? this.#db
          .prepare(`SELECT * FROM threads WHERE project_path = ? ORDER BY created_at DESC`)
          .all(projectPath)
      : this.#db.prepare(`SELECT * FROM threads ORDER BY created_at DESC`).all()
    return rows.map(toThread)
  }

  renameThread(id: string, title: string): void {
    this.#db.prepare(`UPDATE threads SET title = ? WHERE id = ?`).run(title, id)
  }

  setThreadPinned(id: string, pinned: boolean): void {
    this.#db.prepare(`UPDATE threads SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
  }

  settleThread(
    id: string,
    reason: 'manual' | 'inactivity' | 'change_request',
    at = Date.now(),
  ): ThreadLifecycle {
    this.#updateThread(
      `UPDATE threads SET lifecycle_state = 'settled', lifecycle_at = ?, lifecycle_reason = ?,
       wake_at = NULL, keep_active = 0, woke_at = NULL WHERE id = ?`,
      at,
      reason,
      id,
    )
    return { state: 'settled', settledAt: at, reason }
  }

  snoozeThread(id: string, wakeAt: number, at = Date.now()): ThreadLifecycle {
    this.#updateThread(
      `UPDATE threads SET lifecycle_state = 'snoozed', lifecycle_at = ?,
       lifecycle_reason = NULL, wake_at = ?, keep_active = 0, woke_at = NULL WHERE id = ?`,
      at,
      wakeAt,
      id,
    )
    return { state: 'snoozed', snoozedAt: at, wakeAt }
  }

  activateThread(id: string, at = Date.now()): ThreadLifecycle {
    const before = this.thread(id)
    if (!before) throw new Error('thread not found')
    const wokeAt = before.lifecycle.state === 'active' ? before.lifecycle.wokeAt : at
    const keepActive = before.lifecycle.state === 'active' ? before.lifecycle.keepActive : false
    this.#db
      .prepare(
        `UPDATE threads SET lifecycle_state = 'active', lifecycle_at = NULL,
         lifecycle_reason = NULL, wake_at = NULL, woke_at = ? WHERE id = ?`,
      )
      .run(wokeAt ?? null, id)
    return { state: 'active', keepActive, ...(wokeAt === undefined ? {} : { wokeAt }) }
  }

  setThreadKeepActive(id: string, keepActive: boolean, at = Date.now()): ThreadLifecycle {
    const lifecycle = this.activateThread(id, at)
    this.#db.prepare(`UPDATE threads SET keep_active = ? WHERE id = ?`).run(keepActive ? 1 : 0, id)
    return {
      state: 'active',
      keepActive,
      ...(lifecycle.state === 'active' && lifecycle.wokeAt !== undefined
        ? { wokeAt: lifecycle.wokeAt }
        : {}),
    }
  }

  touchThread(id: string, unread = false, at = Date.now()): ThreadLifecycle {
    const lifecycle = this.activateThread(id, at)
    this.#db
      .prepare(`UPDATE threads SET last_active_at = ?, unread = MAX(unread, ?) WHERE id = ?`)
      .run(at, unread ? 1 : 0, id)
    return lifecycle
  }

  markThreadRead(id: string): void {
    this.#updateThread(`UPDATE threads SET unread = 0, woke_at = NULL WHERE id = ?`, id)
  }

  dueSnoozedThreads(now = Date.now()): StoredThread[] {
    return this.#db
      .prepare(
        `SELECT * FROM threads WHERE closed_at IS NULL AND lifecycle_state = 'snoozed'
         AND wake_at <= ? ORDER BY wake_at`,
      )
      .all(now)
      .map(toThread)
  }

  inactiveThreads(cutoff: number): StoredThread[] {
    return this.#db
      .prepare(
        `SELECT * FROM threads WHERE closed_at IS NULL AND lifecycle_state = 'active'
         AND keep_active = 0 AND last_active_at <= ? ORDER BY last_active_at`,
      )
      .all(cutoff)
      .map(toThread)
  }

  sidebarSettings(): SidebarSettings {
    const row = this.#db
      .prepare(`SELECT mode, auto_settle_days FROM sidebar_settings WHERE id = 1`)
      .get() as {
      mode: 'classic' | 'inbox'
      auto_settle_days: number | null
    }
    return { mode: row.mode, autoSettleDays: row.auto_settle_days }
  }

  updateSidebarSettings(settings: Partial<SidebarSettings>): SidebarSettings {
    const current = this.sidebarSettings()
    const next = { ...current, ...settings }
    this.#db
      .prepare(`UPDATE sidebar_settings SET mode = ?, auto_settle_days = ? WHERE id = 1`)
      .run(next.mode, next.autoSettleDays)
    return next
  }

  #updateThread(sql: string, ...params: Array<string | number>): void {
    const result = this.#db.prepare(sql).run(...params)
    if (result.changes === 0) throw new Error('thread not found')
  }

  /**
   * Marks a session finished without discarding it. Closing a session ends the
   * process; it does not mean the user wanted the transcript gone.
   */
  closeThread(id: string): void {
    this.#db.prepare(`UPDATE threads SET closed_at = ? WHERE id = ?`).run(Date.now(), id)
  }

  deleteThread(id: string): void {
    if (this.thread(id)?.worktreePath) {
      throw new Error('discard the isolated session checkout before deleting it')
    }
    // One transaction: a failure partway must not leave orphaned rows with
    // no owner and no path to ever clean them up.
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`DELETE FROM session_search WHERE thread_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM events WHERE thread_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM restore_undos WHERE thread_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM diff_decisions WHERE thread_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM design_runs WHERE thread_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM threads WHERE id = ?`).run(id)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  setDesignRun(threadId: string, payload: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO design_runs (thread_id, payload) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(threadId, JSON.stringify(payload))
  }

  designRun(threadId: string): unknown {
    const row = this.#db
      .prepare(`SELECT payload FROM design_runs WHERE thread_id = ?`)
      .get(threadId) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : undefined
  }

  deleteDesignRun(threadId: string): void {
    this.#db.prepare(`DELETE FROM design_runs WHERE thread_id = ?`).run(threadId)
  }

  setDiffDecision(threadId: string, targetId: string, decision: DiffDecision): void {
    this.#db
      .prepare(
        `INSERT INTO diff_decisions (thread_id, target_id, decision) VALUES (?, ?, ?)
         ON CONFLICT (thread_id, target_id) DO UPDATE SET decision = excluded.decision`,
      )
      .run(threadId, targetId, decision)
  }

  diffDecision(threadId: string, targetId: string): DiffDecision | undefined {
    const row = this.#db
      .prepare(`SELECT decision FROM diff_decisions WHERE thread_id = ? AND target_id = ?`)
      .get(threadId, targetId) as { decision: DiffDecision } | undefined
    return row?.decision
  }

  // ---- events ------------------------------------------------------------

  /** Returns the sequence number, which is what a client resumes from. */
  append(threadId: string, event: DomainEvent): number {
    const at = Date.now()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#insertEvent.run(threadId, at, JSON.stringify(event))
      const seq = Number(result.lastInsertRowid)
      this.#indexEvent(seq, threadId, at, event)
      this.#db.exec('COMMIT')
      return seq
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * The thread's history, optionally only what happened after `afterSeq`.
   *
   * A client that was connected and fell behind asks for the tail; one opening
   * the thread fresh asks for all of it. Same call either way.
   */
  history(threadId: string, afterSeq = 0): Array<{ seq: number; event: DomainEvent }> {
    return this.#db
      .prepare(`SELECT seq, payload FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq`)
      .all(threadId, afterSeq)
      .map((row) => {
        const { seq, payload } = row as { seq: number; payload: string }
        return { seq: Number(seq), event: JSON.parse(payload) as DomainEvent }
      })
  }

  searchSessions(options: SessionSearchOptions): SessionSearchPage {
    const requestedLimit = options.limit ?? 25
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 25
    const cursor = decodeCursor(options.cursor)
    const clauses = ['session_search MATCH ?']
    const parameters: Array<string | number> = [toFtsQuery(options.query)]

    if (options.projectPath) {
      clauses.push('threads.project_path = ?')
      parameters.push(options.projectPath)
    }
    if (options.provider) {
      clauses.push('threads.provider = ?')
      parameters.push(options.provider)
    }

    const cursorClause = cursor
      ? `WHERE score > ?
            OR (score = ? AND created_at < ?)
            OR (score = ? AND created_at = ? AND search_rowid < ?)`
      : ''
    const cursorParameters = cursor
      ? [cursor.score, cursor.score, cursor.createdAt, cursor.score, cursor.createdAt, cursor.rowid]
      : []
    const rows = this.#db
      .prepare(
        `WITH matches AS (
           SELECT projects.path AS project_path, projects.name AS project_name,
                  threads.id AS thread_id, threads.title AS thread_title,
                  threads.provider, session_search.turn_id, session_search.created_at,
                  session_search.rowid AS search_rowid, bm25(session_search) AS score,
                  snippet(session_search, 4, ?, ?, ' … ', 24) AS snippet
           FROM session_search
           JOIN threads ON threads.id = session_search.thread_id
           JOIN projects ON projects.path = threads.project_path
           WHERE ${clauses.join(' AND ')}
         )
         SELECT * FROM matches
         ${cursorClause}
         ORDER BY score, created_at DESC, search_rowid DESC
         LIMIT ?`,
      )
      .all(SNIPPET_START, SNIPPET_END, ...parameters, ...cursorParameters, limit + 1) as Array<{
      project_path: string
      project_name: string
      thread_id: string
      thread_title: string
      provider: ProviderId
      turn_id: string
      created_at: number
      search_rowid: number
      score: number
      snippet: string
    }>

    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      results: page.map((row) => ({
        projectPath: row.project_path,
        projectName: row.project_name,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        turnId: row.turn_id,
        provider: row.provider,
        createdAt: Number(row.created_at),
        snippet: parseSnippet(row.snippet),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              score: Number(last.score),
              createdAt: Number(last.created_at),
              rowid: Number(last.search_rowid),
            })
          : null,
    }
  }

  #rebuildSearchIndex(): void {
    // Batched: loading the entire events table into memory at construction
    // was a startup hang for a database with months of streamed history.
    const batch = this.#db.prepare(
      `SELECT seq, thread_id, at, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 5000`,
    )
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.exec(`DELETE FROM session_search`)
      let cursor = 0
      for (;;) {
        const rows = batch.all(cursor) as Array<{
          seq: number
          thread_id: string
          at: number
          payload: string
        }>
        if (rows.length === 0) break
        for (const row of rows) {
          this.#indexEvent(row.seq, row.thread_id, row.at, JSON.parse(row.payload) as DomainEvent)
        }
        cursor = rows.at(-1)?.seq ?? cursor
      }
      this.#db
        .prepare(`INSERT OR REPLACE INTO schema_migrations (name) VALUES (?)`)
        .run(SEARCH_INDEX_VERSION)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #indexEvent(seq: number, threadId: string, at: number, event: DomainEvent): void {
    const entry = searchableEntry(event)
    if (!entry) return
    this.#insertSearchEntry.run(seq, threadId, seq, entry.turnId, entry.createdAt ?? at, entry.text)
  }

  /** Persistent totals derived from the event log that already owns usage. */
  usageEvents(): StoredUsageEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT e.thread_id, e.at, e.payload, t.provider
         FROM events e JOIN threads t ON t.id = e.thread_id
         WHERE e.payload LIKE '%"usage.updated"%'
         ORDER BY e.thread_id, e.seq`,
      )
      .all() as Array<{ thread_id: string; at: number; payload: string; provider: ProviderId }>

    const events: StoredUsageEvent[] = []
    for (const row of rows) {
      const event = JSON.parse(row.payload) as DomainEvent
      if (event.type !== 'usage.updated') continue
      events.push({
        threadId: row.thread_id,
        provider: row.provider,
        at: row.at,
        usage: event.usage,
      })
    }
    return events
  }

  usageSummary(threadId: string, since: number): { session: UsageTotal; today: UsageTotal } {
    const thread = this.thread(threadId)
    if (!thread) return { session: emptyUsage(), today: emptyUsage() }

    // The LIKE prefilter keeps SQLite from handing us every delta chunk ever
    // streamed just to find the rare usage rows; the type check below still
    // decides for real. Substring match, so key order in the payload is
    // irrelevant and a false positive costs one JSON.parse, not correctness.
    //
    // Two bounded scans instead of one unbounded one: the session total only
    // needs this thread's rows, and "today" only needs rows since midnight —
    // across every provider, because the user's day is not provider-scoped.
    const parseUsage = (
      payload: string,
    ): { total: UsageTotal; cumulative: boolean } | undefined => {
      const event = JSON.parse(payload) as DomainEvent
      return event.type === 'usage.updated'
        ? { total: withoutContext(event.usage), cumulative: event.usage.cumulative === true }
        : undefined
    }

    let session = emptyUsage()
    {
      const rows = this.#db
        .prepare(
          `SELECT payload FROM events
           WHERE thread_id = ? AND payload LIKE '%"usage.updated"%' ORDER BY seq`,
        )
        .all(threadId) as Array<{ payload: string }>
      let previous: UsageTotal | undefined
      for (const row of rows) {
        const sample = parseUsage(row.payload)
        if (!sample) continue
        const current = sample.total
        const increment = sample.cumulative ? usageIncrement(current, previous) : current
        if (sample.cumulative) previous = current
        session = addUsage(session, increment)
      }
    }

    let today = emptyUsage()
    {
      // Seed each thread with its last usage row before the window, so a
      // running-total provider's first in-window increment is a diff, not the
      // whole session so far.
      const previous = new Map<string, UsageTotal>()
      const seeds = this.#db
        .prepare(
          `SELECT e.thread_id, e.payload
           FROM events e
           JOIN (SELECT thread_id, MAX(seq) AS seq FROM events
                 WHERE payload LIKE '%"usage.updated"%' AND at < ? GROUP BY thread_id) last
             ON e.thread_id = last.thread_id AND e.seq = last.seq`,
        )
        .all(since) as Array<{ thread_id: string; payload: string }>
      for (const seed of seeds) {
        const usage = parseUsage(seed.payload)
        if (usage?.cumulative) previous.set(seed.thread_id, usage.total)
      }

      const rows = this.#db
        .prepare(
          `SELECT e.thread_id, e.payload, t.provider
           FROM events e JOIN threads t ON t.id = e.thread_id
           WHERE e.at >= ? AND e.payload LIKE '%"usage.updated"%'
           ORDER BY e.thread_id, e.seq`,
        )
        .all(since) as Array<{ thread_id: string; payload: string; provider: string }>
      for (const row of rows) {
        const sample = parseUsage(row.payload)
        if (!sample) continue
        const current = sample.total
        const increment = sample.cumulative
          ? usageIncrement(current, previous.get(row.thread_id))
          : current
        if (sample.cumulative) previous.set(row.thread_id, current)
        today = addUsage(today, increment)
      }
    }

    return { session, today }
  }

  // ---- checkpoints -------------------------------------------------------

  addCheckpoint(entry: {
    threadId: string
    seq: number
    commit: string
    label: string
  }): StoredCheckpoint {
    const createdAt = Date.now()
    const result = this.#db
      .prepare(
        `INSERT INTO checkpoints (thread_id, seq, commit_sha, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.threadId, entry.seq, entry.commit, entry.label, createdAt)
    return { id: Number(result.lastInsertRowid), createdAt, ...entry }
  }

  checkpoints(threadId: string): StoredCheckpoint[] {
    return this.#db
      .prepare(`SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY seq`)
      .all(threadId)
      .map((row) => {
        const r = row as {
          id: number
          thread_id: string
          seq: number
          commit_sha: string
          label: string
          created_at: number
        }
        return {
          id: Number(r.id),
          threadId: r.thread_id,
          seq: Number(r.seq),
          commit: r.commit_sha,
          label: r.label,
          createdAt: Number(r.created_at),
        }
      })
  }

  checkpoint(id: number): StoredCheckpoint | undefined {
    const row = this.#db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id) as
      | {
          id: number
          thread_id: string
          seq: number
          commit_sha: string
          label: string
          created_at: number
        }
      | undefined
    if (!row) return undefined
    return {
      id: Number(row.id),
      threadId: row.thread_id,
      seq: Number(row.seq),
      commit: row.commit_sha,
      label: row.label,
      createdAt: Number(row.created_at),
    }
  }

  /**
   * Drop everything after a point in the conversation.
   *
   * Rolling the files back without this would leave the thread describing work
   * that no longer exists on disk — the transcript and the repository telling
   * two different stories.
   */
  #truncateAfter(threadId: string, seq: number): void {
    this.#db
      .prepare(
        `DELETE FROM session_search
         WHERE rowid IN (SELECT seq FROM events WHERE thread_id = ? AND seq > ?)`,
      )
      .run(threadId, seq)
    this.#db.prepare(`DELETE FROM events WHERE thread_id = ? AND seq > ?`).run(threadId, seq)
    this.#db.prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND seq > ?`).run(threadId, seq)
  }

  /** Save and remove the conversation tail so a restore remains reversible. */
  saveRestoreUndo(threadId: string, seq: number, commit: string): string {
    const token = randomUUID()
    const events = this.#db
      .prepare(`SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq`)
      .all(threadId, seq)
    const checkpoints = this.#db
      .prepare(`SELECT * FROM checkpoints WHERE thread_id = ? AND seq > ? ORDER BY seq`)
      .all(threadId, seq)

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`DELETE FROM restore_undos WHERE thread_id = ?`).run(threadId)
      this.#db
        .prepare(
          `INSERT INTO restore_undos
             (token, thread_id, checkpoint_seq, snapshot_commit, events_json, checkpoints_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(token, threadId, seq, commit, JSON.stringify(events), JSON.stringify(checkpoints))
      this.#truncateAfter(threadId, seq)
      this.#db.exec('COMMIT')
      return token
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  restoreUndo(threadId: string, token: string): { commit: string } | undefined {
    const row = this.#db
      .prepare(`SELECT snapshot_commit FROM restore_undos WHERE thread_id = ? AND token = ?`)
      .get(threadId, token) as { snapshot_commit: string } | undefined
    return row ? { commit: row.snapshot_commit } : undefined
  }

  /** Put back the exact event/checkpoint rows removed by the latest restore. */
  applyRestoreUndo(threadId: string, token: string): void {
    const row = this.#db
      .prepare(`SELECT * FROM restore_undos WHERE thread_id = ? AND token = ?`)
      .get(threadId, token) as
      | {
          checkpoint_seq: number
          events_json: string
          checkpoints_json: string
        }
      | undefined
    if (!row) throw new Error('restore can no longer be undone')
    if (this.lastSeq(threadId) > Number(row.checkpoint_seq)) {
      throw new Error('restore can only be undone before the session continues')
    }

    const events = JSON.parse(row.events_json) as Array<{
      seq: number
      thread_id: string
      at: number
      payload: string
    }>
    const checkpoints = JSON.parse(row.checkpoints_json) as Array<{
      id: number
      thread_id: string
      seq: number
      commit_sha: string
      label: string
      created_at: number
    }>

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const insertEvent = this.#db.prepare(
        `INSERT INTO events (seq, thread_id, at, payload) VALUES (?, ?, ?, ?)`,
      )
      for (const event of events) {
        insertEvent.run(event.seq, event.thread_id, event.at, event.payload)
        this.#indexEvent(
          event.seq,
          event.thread_id,
          event.at,
          JSON.parse(event.payload) as DomainEvent,
        )
      }
      const insertCheckpoint = this.#db.prepare(
        `INSERT INTO checkpoints (id, thread_id, seq, commit_sha, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const checkpoint of checkpoints) {
        insertCheckpoint.run(
          checkpoint.id,
          checkpoint.thread_id,
          checkpoint.seq,
          checkpoint.commit_sha,
          checkpoint.label,
          checkpoint.created_at,
        )
      }
      this.#db.prepare(`DELETE FROM restore_undos WHERE token = ?`).run(token)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  lastSeq(threadId: string): number {
    const row = this.#db
      .prepare(`SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?`)
      .get(threadId)
    const seq = (row as { seq: number | null } | undefined)?.seq
    return seq ? Number(seq) : 0
  }
}

function searchableEntry(
  event: DomainEvent,
): { turnId: string; createdAt?: number | undefined; text: string } | undefined {
  if (event.type !== 'item.completed') return undefined
  const { item } = event
  const text =
    item.type === 'message'
      ? item.text
      : item.type === 'command'
        ? [item.command, item.text].filter(Boolean).join('\n')
        : item.type === 'tool_call' || item.type === 'error'
          ? item.text
          : undefined
  if (!text?.trim()) return undefined
  return { turnId: item.turnId, createdAt: item.createdAt, text }
}

function toFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) throw new Error('search query cannot be empty')
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ')
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(cursor: string | undefined): SearchCursor | undefined {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as SearchCursor
    if (
      !Number.isFinite(value.score) ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      !Number.isSafeInteger(value.rowid) ||
      value.rowid < 1
    ) {
      return undefined
    }
    return value
  } catch {
    return undefined
  }
}

function parseSnippet(value: string): SessionSearchResult['snippet'] {
  const parts: SessionSearchResult['snippet'] = []
  let highlighted = false
  let text = ''
  const push = () => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.highlighted === highlighted) previous.text += text
    else parts.push({ text, highlighted })
    text = ''
  }

  for (const character of value) {
    if (character === SNIPPET_START || character === SNIPPET_END) {
      push()
      highlighted = character === SNIPPET_START
    } else {
      text += character
    }
  }
  push()
  return parts.length > 0 ? parts : [{ text: value, highlighted: false }]
}

type UsageTotal = Omit<Usage, 'contextWindow' | 'model' | 'cumulative' | 'inputIncludesCached'>

function emptyUsage(): UsageTotal {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

function withoutContext(usage: Usage): UsageTotal {
  const {
    contextWindow: _contextWindow,
    model: _model,
    cumulative: _cumulative,
    inputIncludesCached: _inputIncludesCached,
    ...total
  } = usage
  // ACP can report context occupancy and cumulative cost without end-turn
  // token accounting. Keep the cost, but don't turn "tokens currently in
  // context" into tokens processed by the session summary.
  return usage.contextWindow &&
    total.inputTokens === 0 &&
    total.cachedInputTokens === 0 &&
    total.outputTokens === 0 &&
    total.reasoningTokens === 0
    ? { ...total, totalTokens: 0 }
    : total
}

function addUsage(left: UsageTotal, right: UsageTotal): UsageTotal {
  const hasCost = left.costUsd !== undefined || right.costUsd !== undefined
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(hasCost ? { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) } : {}),
  }
}

function usageIncrement(current: UsageTotal, previous = emptyUsage()): UsageTotal {
  const delta = (now: number, before: number) => (now >= before ? now - before : now)
  const costUsd =
    current.costUsd === undefined ? undefined : delta(current.costUsd, previous.costUsd ?? 0)
  return {
    inputTokens: delta(current.inputTokens, previous.inputTokens),
    cachedInputTokens: delta(current.cachedInputTokens, previous.cachedInputTokens),
    outputTokens: delta(current.outputTokens, previous.outputTokens),
    reasoningTokens: delta(current.reasoningTokens, previous.reasoningTokens),
    totalTokens: delta(current.totalTokens, previous.totalTokens),
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

function toProject(row: unknown): StoredProject {
  const r = row as { path: string; name: string; pinned: number; created_at: number }
  return {
    path: r.path,
    name: r.name,
    pinned: r.pinned === 1,
    createdAt: Number(r.created_at),
  }
}

function toThread(row: unknown): StoredThread {
  const r = row as {
    id: string
    project_path: string
    provider: string
    agent: string | null
    title: string
    pinned: number
    created_at: number
    closed_at: number | null
    worktree_path: string | null
    worktree_branch: string | null
    lifecycle_state: 'active' | 'settled' | 'snoozed'
    lifecycle_at: number | null
    lifecycle_reason: 'manual' | 'inactivity' | 'change_request' | null
    wake_at: number | null
    keep_active: number
    woke_at: number | null
    unread: number
    last_active_at: number
  }
  // Null timestamps (rows migrated before these columns existed) must not
  // become NaN — a snoozed thread with NaN wakeAt can never be woken.
  const lifecycle: ThreadLifecycle =
    r.lifecycle_state === 'settled'
      ? {
          state: 'settled',
          settledAt: Number(r.lifecycle_at ?? r.created_at),
          reason: r.lifecycle_reason ?? 'manual',
        }
      : r.lifecycle_state === 'snoozed'
        ? {
            state: 'snoozed',
            snoozedAt: Number(r.lifecycle_at ?? r.created_at),
            wakeAt: Number(r.wake_at ?? r.created_at),
          }
        : {
            state: 'active',
            keepActive: r.keep_active === 1,
            ...(r.woke_at === null ? {} : { wokeAt: Number(r.woke_at) }),
          }
  return {
    id: r.id,
    projectPath: r.project_path,
    provider: r.provider as ProviderId,
    ...(r.agent === null ? {} : { agent: r.agent }),
    title: r.title,
    pinned: r.pinned === 1,
    createdAt: Number(r.created_at),
    ...(r.closed_at === null ? {} : { closedAt: Number(r.closed_at) }),
    ...(r.worktree_path === null ? {} : { worktreePath: r.worktree_path }),
    ...(r.worktree_branch === null ? {} : { worktreeBranch: r.worktree_branch }),
    lifecycle,
    unread: r.unread === 1,
    lastActiveAt: Number(r.last_active_at),
  }
}

function toPairedDevice(row: unknown): PairedDevice {
  const device = row as {
    id: string
    name: string
    created_at: number
    last_seen_at: number
  }
  return {
    id: device.id,
    name: device.name,
    createdAt: Number(device.created_at),
    lastSeenAt: Number(device.last_seen_at),
  }
}
