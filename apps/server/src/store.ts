import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import {
  BackgroundModelPreferenceSchema,
  DiffDecisionSchema,
  DomainEventSchema,
  JsonValueSchema,
  ProviderIdSchema,
} from '@harness/contracts'
import type {
  BackgroundModelPreference,
  DiffDecision,
  DomainEvent,
  JsonValue,
  ProviderId,
  SidebarSettings,
  SessionSearchResult,
  ThreadLifecycle,
  Usage,
} from '@harness/contracts'
import { z } from 'zod'
import type { TurnOptions } from './adapters.js'
import { propertiesWhen } from './properties-when.js'

const BACKGROUND_MODEL_SETTING = 'background-model'

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
  /** Temporary fork owned by Side chat; never shown in project history. */
  ephemeral: boolean
  /** Main conversation captured when an ephemeral Side chat was created. */
  parentThreadId?: string | undefined
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

export type StoredQueuedTurn = {
  id: string
  threadId: string
  clientSubmissionId?: string | undefined
  text: string
  attachments: string[]
  options: TurnOptions
  createdAt: number
  intent: 'normal' | 'steer'
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

type SearchCursor = {
  snapshotId: string
  position: number
}

type SearchSnapshot = {
  ftsQuery: string
  projectPath: string | null
  provider: ProviderId | null
}

export type UsageSummary = { session: UsageTotal; today: UsageTotal }

type UsageSample = { total: UsageTotal; cumulative: boolean }

type SqliteRow = Record<string, SQLOutputValue>

type InterruptedThreadState = {
  openTurns: Set<string>
  activeItems: Map<string, Extract<DomainEvent, { type: 'item.started' }>['item']>
  approvals: Set<string>
  userInputs: Set<string>
  reviews: Map<string, Extract<DomainEvent, { type: 'approval.review.started' }>['review']>
  hasResumableInput: boolean
}

const RESTART_INTERRUPTION_MESSAGE =
  'Turn interrupted: TasteCode restarted. Send a new message to continue.'

const SNIPPET_START = '\u0001'
const SNIPPET_END = '\u0002'
const SEARCH_INDEX_VERSION = 'session_search_v1'
const SEARCH_RESULT_KEY_SETTING = 'search_result_key_v1'
const SEARCH_SNAPSHOT_TTL_MS = 5 * 60 * 1_000
const MAX_SEARCH_SNAPSHOTS = 32
const SEARCH_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*/gu

const SEARCH_SNAPSHOT_SCHEMA = `
CREATE TEMP TABLE session_search_snapshots (
  id           TEXT PRIMARY KEY,
  fts_query    TEXT NOT NULL,
  project_path TEXT,
  provider     TEXT,
  expires_at   INTEGER NOT NULL
);

CREATE TEMP TABLE session_search_snapshot_rows (
  position     INTEGER PRIMARY KEY,
  snapshot_id  TEXT NOT NULL,
  search_rowid INTEGER NOT NULL,
  snippet      TEXT NOT NULL,
  UNIQUE (snapshot_id, search_rowid)
);

CREATE INDEX session_search_snapshot_page
  ON session_search_snapshot_rows (snapshot_id, position);
`

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
  last_active_at   INTEGER NOT NULL,
  ephemeral        INTEGER NOT NULL DEFAULT 0,
  parent_thread_id TEXT
);

CREATE TABLE IF NOT EXISTS sidebar_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mode             TEXT NOT NULL CHECK (mode IN ('classic', 'inbox')),
  auto_settle_days INTEGER CHECK (auto_settle_days BETWEEN 1 AND 90)
);

INSERT OR IGNORE INTO sidebar_settings (id, mode, auto_settle_days) VALUES (1, 'classic', 3);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queued_turn_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  queue_id  TEXT,
  at        INTEGER NOT NULL,
  mutation  TEXT NOT NULL,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queued_turns (
  thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  queue_id             TEXT NOT NULL,
  client_submission_id TEXT,
  position             INTEGER NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('queued', 'dispatching')),
  intent               TEXT NOT NULL CHECK (intent IN ('normal', 'steer')),
  payload              TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (thread_id, queue_id)
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

CREATE INDEX IF NOT EXISTS checkpoints_by_thread ON checkpoints (thread_id, seq);
CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread_id, seq);
CREATE INDEX IF NOT EXISTS queued_turn_events_by_thread
  ON queued_turn_events (thread_id, seq);
CREATE INDEX IF NOT EXISTS queued_turns_by_thread
  ON queued_turns (thread_id, state, position);
CREATE UNIQUE INDEX IF NOT EXISTS queued_turn_submission_id
  ON queued_turns (thread_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;
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
  { table: 'threads', column: 'ephemeral', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'threads', column: 'parent_thread_id', definition: 'TEXT' },
]

const SqliteIntegerSchema = z.union([z.number(), z.bigint()]).transform(Number)
const SqliteColumnRowSchema = z.object({ name: z.string() })
const SqliteIdentifierRowSchema = z.object({ id: z.string() })
const SqliteStringValueRowSchema = z.object({ value: z.string() })
const SqliteProjectRowSchema = z.object({
  path: z.string(),
  name: z.string(),
  pinned: SqliteIntegerSchema,
  created_at: SqliteIntegerSchema,
})
const SqliteWorktreeRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  worktree_path: z.string(),
  worktree_branch: z.string(),
})
const SqliteThreadRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  provider: ProviderIdSchema,
  agent: z.string().nullable(),
  title: z.string(),
  pinned: SqliteIntegerSchema,
  created_at: SqliteIntegerSchema,
  closed_at: SqliteIntegerSchema.nullable(),
  worktree_path: z.string().nullable(),
  worktree_branch: z.string().nullable(),
  lifecycle_state: z.enum(['active', 'settled', 'snoozed']),
  lifecycle_at: SqliteIntegerSchema.nullable(),
  lifecycle_reason: z.enum(['manual', 'inactivity', 'change_request']).nullable(),
  wake_at: SqliteIntegerSchema.nullable(),
  keep_active: SqliteIntegerSchema,
  woke_at: SqliteIntegerSchema.nullable(),
  unread: SqliteIntegerSchema,
  last_active_at: SqliteIntegerSchema,
  ephemeral: SqliteIntegerSchema,
  parent_thread_id: z.string().nullable(),
})
const SqliteSidebarSettingsRowSchema = z.object({
  mode: z.enum(['classic', 'inbox']),
  auto_settle_days: SqliteIntegerSchema.nullable(),
})
const StoredTurnOptionsSchema = z.object({
  model: z.string().optional(),
  serviceTier: z.string().optional(),
  effort: z.string().optional(),
})
const SqliteQueuedTurnPayloadSchema = z.object({
  text: z.string(),
  attachments: z.array(z.string()),
  options: StoredTurnOptionsSchema,
})
const SqliteQueuedTurnRowSchema = z.object({
  thread_id: z.string(),
  queue_id: z.string(),
  client_submission_id: z.string().nullable(),
  intent: z.enum(['normal', 'steer']),
  payload: z.string(),
  created_at: SqliteIntegerSchema,
})
const SqlitePositionRowSchema = z.object({ position: SqliteIntegerSchema })
const SqliteAdjacentQueuedTurnRowSchema = z.object({
  queue_id: z.string(),
  position: SqliteIntegerSchema,
})
const SqliteQueuedTurnClaimRowSchema = z.object({
  thread_id: z.string(),
  queue_id: z.string(),
  intent: z.enum(['normal', 'steer']),
})
const SqliteDiffDecisionRowSchema = z.object({ decision: DiffDecisionSchema })
const SqliteInterruptedThreadRowSchema = z.object({
  thread_id: z.string(),
  payload: z.string(),
  resumable: SqliteIntegerSchema,
})
const SqliteHistoryRowSchema = z.object({ seq: SqliteIntegerSchema, payload: z.string() })
const SqlitePayloadRowSchema = z.object({ payload: z.string() })
const SqliteSearchSnapshotRowSchema = z.object({
  fts_query: z.string(),
  project_path: z.string().nullable(),
  provider: ProviderIdSchema.nullable(),
})
const SqliteSearchResultRowSchema = z.object({
  project_path: z.string(),
  project_name: z.string(),
  thread_id: z.string(),
  thread_title: z.string(),
  provider: ProviderIdSchema,
  event_seq: SqliteIntegerSchema,
  turn_id: z.string(),
  created_at: SqliteIntegerSchema,
  position: SqliteIntegerSchema,
  snippet: z.string(),
})
const SqliteEventRowSchema = z.object({
  seq: SqliteIntegerSchema,
  thread_id: z.string(),
  at: SqliteIntegerSchema,
  payload: z.string(),
})
const SqliteUsageEventRowSchema = z.object({
  thread_id: z.string(),
  at: SqliteIntegerSchema,
  payload: z.string(),
  provider: ProviderIdSchema,
})
const SqliteThreadPayloadRowSchema = z.object({
  thread_id: z.string(),
  payload: z.string(),
})
const SqliteCheckpointRowSchema = z.object({
  id: SqliteIntegerSchema,
  thread_id: z.string(),
  seq: SqliteIntegerSchema,
  commit_sha: z.string(),
  label: z.string(),
  created_at: SqliteIntegerSchema,
})
const SqliteRestoreUndoRowSchema = z.object({
  checkpoint_seq: SqliteIntegerSchema,
  events_json: z.string(),
  checkpoints_json: z.string(),
})
const SqliteMaxSequenceRowSchema = z.object({ seq: SqliteIntegerSchema.nullable() })
const SearchCursorSchema = z.object({
  snapshotId: z.string().min(1),
  position: z.number().safe().int().min(1),
})

export class Store {
  #db: DatabaseSync
  #insertEvent: StatementSync
  #insertSearchEntry: StatementSync
  #searchResultKey: Buffer
  /** Keeps the streamed-event path from querying SQLite just to skip search indexing. */
  #ephemeralThreads = new Set<string>()

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
    this.#db.exec(SEARCH_SNAPSHOT_SCHEMA)
    this.#searchResultKey = this.#loadSearchResultKey()
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
    this.#purgeEphemeralThreads()
    this.#recoverQueuedTurnClaims()
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
        .map((row) => SqliteColumnRowSchema.parse(row).name)
      if (columns.includes(column)) continue
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.#db.exec(`UPDATE threads SET last_active_at = created_at WHERE last_active_at = 0`)
  }

  /** Side chats intentionally do not survive an app restart or a crashed renderer. */
  #purgeEphemeralThreads(): void {
    const ids = this.#db
      .prepare(`SELECT id FROM threads WHERE ephemeral = 1`)
      .all()
      .map((row) => SqliteIdentifierRowSchema.parse(row).id)
    for (const id of ids) this.deleteThread(id)
  }

  close(): void {
    this.#db.close()
  }

  #loadSearchResultKey(): Buffer {
    this.#db
      .prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`)
      .run(SEARCH_RESULT_KEY_SETTING, randomBytes(32).toString('base64url'))
    const row = SqliteStringValueRowSchema.parse(
      this.#db
        .prepare(`SELECT value FROM app_settings WHERE key = ?`)
        .get(SEARCH_RESULT_KEY_SETTING),
    )
    const key = Buffer.from(row.value, 'base64url')
    if (key.length !== 32) throw new Error('Search result identity key is invalid.')
    return key
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
    thread: Omit<
      StoredThread,
      'createdAt' | 'pinned' | 'lifecycle' | 'unread' | 'lastActiveAt' | 'ephemeral'
    > & {
      createdAt?: number
      ephemeral?: boolean
    },
  ): StoredThread {
    const stored = { ...thread, createdAt: thread.createdAt ?? Date.now() }
    const ephemeral = thread.ephemeral ?? false
    const lifecycle = { state: 'active', keepActive: false } as const
    this.#db
      .prepare(
        `INSERT INTO threads
          (id, project_path, provider, agent, title, created_at, worktree_path, worktree_branch,
            lifecycle_state, keep_active, unread, last_active_at, ephemeral, parent_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?)`,
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
        ephemeral ? 1 : 0,
        stored.parentThreadId ?? null,
      )
    if (ephemeral) this.#ephemeralThreads.add(stored.id)
    return {
      ...stored,
      pinned: false,
      lifecycle,
      unread: false,
      lastActiveAt: stored.createdAt,
      ephemeral,
    }
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
                WHERE worktree_path IS NOT NULL AND ephemeral = 0`,
      )
      .all()
      .map((row) => {
        const r = SqliteWorktreeRowSchema.parse(row)
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
          .prepare(
            `SELECT * FROM threads WHERE project_path = ? AND ephemeral = 0 ORDER BY created_at DESC`,
          )
          .all(projectPath)
      : this.#db.prepare(`SELECT * FROM threads WHERE ephemeral = 0 ORDER BY created_at DESC`).all()
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
    return {
      state: 'active',
      keepActive,
      ...propertiesWhen(!(wokeAt === undefined), () => ({ wokeAt })),
    }
  }

  setThreadKeepActive(id: string, keepActive: boolean, at = Date.now()): ThreadLifecycle {
    const lifecycle = this.activateThread(id, at)
    this.#db.prepare(`UPDATE threads SET keep_active = ? WHERE id = ?`).run(keepActive ? 1 : 0, id)
    const wokeAt = lifecycle.state === 'active' ? lifecycle.wokeAt : undefined
    return {
      state: 'active',
      keepActive,
      ...propertiesWhen(
        wokeAt === undefined ? undefined : { wokeAt },
        (includedWokeAt) => includedWokeAt,
      ),
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
         AND ephemeral = 0 AND wake_at <= ? ORDER BY wake_at`,
      )
      .all(now)
      .map(toThread)
  }

  inactiveThreads(cutoff: number): StoredThread[] {
    return this.#db
      .prepare(
        `SELECT * FROM threads WHERE closed_at IS NULL AND lifecycle_state = 'active'
         AND ephemeral = 0 AND keep_active = 0 AND last_active_at <= ? ORDER BY last_active_at`,
      )
      .all(cutoff)
      .map(toThread)
  }

  sidebarSettings(): SidebarSettings {
    const row = SqliteSidebarSettingsRowSchema.parse(
      this.#db.prepare(`SELECT mode, auto_settle_days FROM sidebar_settings WHERE id = 1`).get(),
    )
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

  backgroundModelPreference(): BackgroundModelPreference {
    const rawRow = this.#db
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get(BACKGROUND_MODEL_SETTING)
    if (!rawRow) return { mode: 'automatic' }
    const row = SqliteStringValueRowSchema.parse(rawRow)
    try {
      return BackgroundModelPreferenceSchema.parse(JSON.parse(row.value))
    } catch {
      return { mode: 'automatic' }
    }
  }

  updateBackgroundModelPreference(
    preference: BackgroundModelPreference,
  ): BackgroundModelPreference {
    const parsed = BackgroundModelPreferenceSchema.parse(preference)
    this.#db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(BACKGROUND_MODEL_SETTING, JSON.stringify(parsed))
    return parsed
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
    this.#transaction(() => {
      this.#clearQueuedTurns(id)
      this.#db.prepare(`UPDATE threads SET closed_at = ? WHERE id = ?`).run(Date.now(), id)
    })
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
      this.#ephemeralThreads.delete(id)
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  setDesignRun<T>(threadId: string, payload: T): void {
    this.#db
      .prepare(
        `INSERT INTO design_runs (thread_id, payload) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(threadId, serializeJson(payload))
  }

  designRun(threadId: string): JsonValue | undefined {
    const rawRow = this.#db
      .prepare(`SELECT payload FROM design_runs WHERE thread_id = ?`)
      .get(threadId)
    if (!rawRow) return undefined
    const row = SqlitePayloadRowSchema.parse(rawRow)
    return JsonValueSchema.parse(JSON.parse(row.payload))
  }

  deleteDesignRun(threadId: string): void {
    this.#db.prepare(`DELETE FROM design_runs WHERE thread_id = ?`).run(threadId)
  }

  // ---- queued turns -----------------------------------------------------

  queuedTurns(threadId: string): StoredQueuedTurn[] {
    return this.#db
      .prepare(
        `SELECT queued_turns.* FROM queued_turns
         INNER JOIN threads ON threads.id = queued_turns.thread_id
         WHERE queued_turns.thread_id = ? AND queued_turns.state = 'queued'
           AND threads.closed_at IS NULL
         ORDER BY queued_turns.position`,
      )
      .all(threadId)
      .map(toQueuedTurn)
  }

  hasQueuedSubmission(threadId: string, clientSubmissionId: string): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM queued_turns
           WHERE thread_id = ? AND client_submission_id = ? LIMIT 1`,
        )
        .get(threadId, clientSubmissionId) !== undefined
    )
  }

  enqueueQueuedTurn(turn: Omit<StoredQueuedTurn, 'intent'>): void {
    const payload = JSON.stringify({
      text: turn.text,
      attachments: turn.attachments,
      options: turn.options,
    })
    this.#transaction(() => {
      const open = this.#db
        .prepare(`SELECT 1 FROM threads WHERE id = ? AND closed_at IS NULL`)
        .get(turn.threadId)
      if (!open) throw new Error('thread not found')
      const position = Number(
        SqlitePositionRowSchema.parse(
          this.#db
            .prepare(
              `SELECT COALESCE(MAX(position), -1) + 1 AS position
               FROM queued_turns WHERE thread_id = ?`,
            )
            .get(turn.threadId),
        ).position,
      )
      this.#appendQueuedTurnEvent(turn.threadId, turn.id, 'enqueue', {
        ...turn,
        intent: 'normal',
        position,
      })
      this.#db
        .prepare(
          `INSERT INTO queued_turns
             (thread_id, queue_id, client_submission_id, position, state, intent, payload, created_at)
           VALUES (?, ?, ?, ?, 'queued', 'normal', ?, ?)`,
        )
        .run(
          turn.threadId,
          turn.id,
          turn.clientSubmissionId ?? null,
          position,
          payload,
          turn.createdAt,
        )
    })
  }

  deleteQueuedTurn(threadId: string, queueId: string): boolean {
    return this.#mutateQueuedTurn(threadId, queueId, 'queued', 'delete', () => {
      this.#db
        .prepare(`DELETE FROM queued_turns WHERE thread_id = ? AND queue_id = ?`)
        .run(threadId, queueId)
    })
  }

  moveQueuedTurn(threadId: string, queueId: string, direction: 'up' | 'down'): boolean {
    return this.#transaction(() => {
      const rawCurrent = this.#db
        .prepare(
          `SELECT position FROM queued_turns
           WHERE thread_id = ? AND queue_id = ? AND state = 'queued'`,
        )
        .get(threadId, queueId)
      if (!rawCurrent) return false
      const current = SqlitePositionRowSchema.parse(rawCurrent)
      const comparison = direction === 'up' ? '<' : '>'
      const order = direction === 'up' ? 'DESC' : 'ASC'
      const rawAdjacent = this.#db
        .prepare(
          `SELECT queue_id, position FROM queued_turns
           WHERE thread_id = ? AND state = 'queued' AND position ${comparison} ?
           ORDER BY position ${order} LIMIT 1`,
        )
        .get(threadId, current.position)
      if (!rawAdjacent) return false
      const adjacent = SqliteAdjacentQueuedTurnRowSchema.parse(rawAdjacent)
      this.#appendQueuedTurnEvent(threadId, queueId, 'move', { direction })
      this.#db
        .prepare(
          `UPDATE queued_turns SET position = CASE queue_id WHEN ? THEN ? WHEN ? THEN ? END
           WHERE thread_id = ? AND queue_id IN (?, ?)`,
        )
        .run(
          queueId,
          adjacent.position,
          adjacent.queue_id,
          current.position,
          threadId,
          queueId,
          adjacent.queue_id,
        )
      return true
    })
  }

  claimQueuedTurn(
    threadId: string,
    queueId: string,
    intent: 'normal' | 'steer',
  ): StoredQueuedTurn | undefined {
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT * FROM queued_turns
           WHERE thread_id = ? AND queue_id = ? AND state = 'queued'`,
        )
        .get(threadId, queueId)
      if (!row) return undefined
      this.#appendQueuedTurnEvent(threadId, queueId, 'claim', { intent })
      this.#db
        .prepare(
          `UPDATE queued_turns SET state = 'dispatching', intent = ?
           WHERE thread_id = ? AND queue_id = ?`,
        )
        .run(intent, threadId, queueId)
      return { ...toQueuedTurn(row), intent }
    })
  }

  restoreQueuedTurn(threadId: string, queueId: string): boolean {
    return this.#mutateQueuedTurn(threadId, queueId, 'dispatching', 'restore', () => {
      this.#db
        .prepare(
          `UPDATE queued_turns SET state = 'queued', intent = 'normal'
           WHERE thread_id = ? AND queue_id = ?`,
        )
        .run(threadId, queueId)
    })
  }

  completeQueuedTurn(threadId: string, queueId: string): boolean {
    return this.#mutateQueuedTurn(threadId, queueId, 'dispatching', 'complete', () => {
      this.#db
        .prepare(`DELETE FROM queued_turns WHERE thread_id = ? AND queue_id = ?`)
        .run(threadId, queueId)
    })
  }

  appendAndCompleteQueuedTurn(threadId: string, queueId: string, event: DomainEvent): number {
    return this.#transaction(() => {
      const claimed = this.#db
        .prepare(
          `SELECT 1 FROM queued_turns
           WHERE thread_id = ? AND queue_id = ? AND state = 'dispatching'`,
        )
        .get(threadId, queueId)
      if (!claimed) throw new Error('queued prompt is no longer claimed')
      const seq = this.#appendEvent(threadId, event, Date.now())
      this.#appendQueuedTurnEvent(threadId, queueId, 'complete', {})
      this.#db
        .prepare(
          `DELETE FROM queued_turns
           WHERE thread_id = ? AND queue_id = ? AND state = 'dispatching'`,
        )
        .run(threadId, queueId)
      return seq
    })
  }

  clearQueuedTurns(threadId: string): void {
    this.#transaction(() => this.#clearQueuedTurns(threadId))
  }

  clearAllQueuedTurns(): string[] {
    return this.#transaction(() => {
      const threadIds = this.#db
        .prepare(`SELECT DISTINCT thread_id FROM queued_turns ORDER BY thread_id`)
        .all()
        .map((row) => SqliteThreadPayloadRowSchema.pick({ thread_id: true }).parse(row).thread_id)
      for (const threadId of threadIds) this.#clearQueuedTurns(threadId)
      return threadIds
    })
  }

  #mutateQueuedTurn(
    threadId: string,
    queueId: string,
    state: 'queued' | 'dispatching',
    mutation: string,
    project: () => void,
  ): boolean {
    return this.#transaction(() => {
      const exists = this.#db
        .prepare(`SELECT 1 FROM queued_turns WHERE thread_id = ? AND queue_id = ? AND state = ?`)
        .get(threadId, queueId, state)
      if (!exists) return false
      this.#appendQueuedTurnEvent(threadId, queueId, mutation, {})
      project()
      return true
    })
  }

  #clearQueuedTurns(threadId: string): void {
    const exists = this.#db
      .prepare(`SELECT 1 FROM queued_turns WHERE thread_id = ? LIMIT 1`)
      .get(threadId)
    if (!exists) return
    this.#appendQueuedTurnEvent(threadId, null, 'clear', {})
    this.#db.prepare(`DELETE FROM queued_turns WHERE thread_id = ?`).run(threadId)
  }

  #appendQueuedTurnEvent<T>(
    threadId: string,
    queueId: string | null,
    mutation: string,
    payload: T,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO queued_turn_events (thread_id, queue_id, at, mutation, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(threadId, queueId, Date.now(), mutation, serializeJson(payload))
  }

  #recoverQueuedTurnClaims(): void {
    const claims = z
      .array(SqliteQueuedTurnClaimRowSchema)
      .parse(
        this.#db
          .prepare(
            `SELECT thread_id, queue_id, intent FROM queued_turns WHERE state = 'dispatching'`,
          )
          .all(),
      )
    if (claims.length === 0) return
    this.#transaction(() => {
      for (const claim of claims) {
        this.#appendQueuedTurnEvent(claim.thread_id, claim.queue_id, 'recover', {
          intent: claim.intent,
        })
      }
      this.#db
        .prepare(
          `UPDATE queued_turns SET state = 'queued', intent = 'normal' WHERE state = 'dispatching'`,
        )
        .run()
    })
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  setDiffDecision(threadId: string, targetId: string, decision: string): void {
    const parsed = DiffDecisionSchema.parse(decision)
    this.#db
      .prepare(
        `INSERT INTO diff_decisions (thread_id, target_id, decision) VALUES (?, ?, ?)
         ON CONFLICT (thread_id, target_id) DO UPDATE SET decision = excluded.decision`,
      )
      .run(threadId, targetId, parsed)
  }

  diffDecision(threadId: string, targetId: string): DiffDecision | undefined {
    const rawRow = this.#db
      .prepare(`SELECT decision FROM diff_decisions WHERE thread_id = ? AND target_id = ?`)
      .get(threadId, targetId)
    return rawRow ? SqliteDiffDecisionRowSchema.parse(rawRow).decision : undefined
  }

  // ---- events ------------------------------------------------------------

  /**
   * Close event lifecycles that cannot still be live in this server process.
   *
   * Agent sessions and their approval callbacks are process-owned. Replaying a
   * request after restart can draw the old approval card, but accepting it can
   * never reach the callback that died with the previous process. Settle that
   * durable state before clients connect so history stays honest and the user
   * gets a clear next action instead of a button that does nothing.
   */
  recoverInterruptedThreads(): string[] {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      // SQLite returns only unfinished lifecycle starts. Months of completed
      // turns and streamed deltas never cross into JavaScript at startup.
      const rows = z.array(SqliteInterruptedThreadRowSchema).parse(
        this.#db
          .prepare(
            `WITH typed_events AS (
             SELECT events.seq, events.thread_id, events.payload,
                    json_extract(events.payload, '$.type') AS event_type
             FROM events
             INNER JOIN threads ON threads.id = events.thread_id
             WHERE threads.closed_at IS NULL
           ),
           lifecycle_events AS (
             SELECT seq, thread_id, payload, event_type,
                    CASE event_type
                      WHEN 'turn.started' THEN 'turn:' || json_extract(payload, '$.turn.id')
                      WHEN 'turn.completed' THEN 'turn:' || json_extract(payload, '$.turnId')
                      WHEN 'item.started' THEN 'item:' || json_extract(payload, '$.item.id')
                      WHEN 'item.completed' THEN 'item:' || json_extract(payload, '$.item.id')
                      WHEN 'approval.requested' THEN 'approval:' || json_extract(payload, '$.request.id')
                      WHEN 'approval.resolved' THEN 'approval:' || json_extract(payload, '$.id')
                      WHEN 'user_input.requested' THEN 'input:' || json_extract(payload, '$.request.id')
                      WHEN 'user_input.resolved' THEN 'input:' || json_extract(payload, '$.id')
                      WHEN 'approval.review.started' THEN 'review:' || json_extract(payload, '$.review.id')
                      WHEN 'approval.review.completed' THEN 'review:' || json_extract(payload, '$.review.id')
                    END AS lifecycle_key
             FROM typed_events
             WHERE event_type IN (
               'turn.started', 'turn.completed', 'thread.error',
               'item.started', 'item.completed',
               'approval.requested', 'approval.resolved',
               'user_input.requested', 'user_input.resolved',
               'approval.review.started', 'approval.review.completed'
             )
           ),
           lifecycle_state AS (
             SELECT thread_id, lifecycle_key,
                    MAX(CASE WHEN event_type IN (
                      'turn.started', 'item.started', 'approval.requested',
                      'user_input.requested', 'approval.review.started') THEN seq END) AS started_seq,
                    MAX(CASE WHEN event_type IN (
                      'turn.completed', 'item.completed', 'approval.resolved',
                      'user_input.resolved', 'approval.review.completed') THEN seq END) AS terminal_seq
             FROM lifecycle_events
             WHERE lifecycle_key IS NOT NULL
             GROUP BY thread_id, lifecycle_key
           ),
           last_errors AS (
             SELECT thread_id, MAX(seq) AS seq FROM lifecycle_events
             WHERE event_type = 'thread.error'
             GROUP BY thread_id
           )
           SELECT started.thread_id, started.payload,
                  CASE WHEN started.event_type = 'user_input.requested'
                    AND EXISTS (
                      SELECT 1 FROM design_runs
                      WHERE design_runs.thread_id = started.thread_id
                        AND json_extract(design_runs.payload, '$.phase') = 'brief'
                    ) THEN 1 ELSE 0 END AS resumable
           FROM lifecycle_state
           INNER JOIN lifecycle_events AS started ON started.seq = lifecycle_state.started_seq
           LEFT JOIN last_errors ON last_errors.thread_id = started.thread_id
           WHERE lifecycle_state.terminal_seq IS NULL
             AND (started.event_type <> 'turn.started' OR last_errors.seq IS NULL
                  OR last_errors.seq < started.seq)
           ORDER BY started.seq`,
          )
          .all(),
      )

      const states = new Map<string, InterruptedThreadState>()
      for (const row of rows) {
        const event = DomainEventSchema.parse(JSON.parse(row.payload))
        const state = states.get(row.thread_id) ?? {
          openTurns: new Set<string>(),
          activeItems: new Map(),
          approvals: new Set<string>(),
          userInputs: new Set<string>(),
          reviews: new Map(),
          hasResumableInput: false,
        }
        states.set(row.thread_id, state)

        if (event.type === 'turn.started') state.openTurns.add(event.turn.id)
        if (event.type === 'item.started') state.activeItems.set(event.item.id, event.item)
        if (event.type === 'approval.requested') state.approvals.add(event.request.id)
        if (event.type === 'user_input.requested') {
          if (row.resumable) state.hasResumableInput = true
          else state.userInputs.add(event.request.id)
        }
        if (event.type === 'approval.review.started') {
          state.reviews.set(event.review.id, event.review)
        }
      }

      const recovered: string[] = []
      const at = Date.now()
      for (const [threadId, state] of states) {
        for (const item of state.activeItems.values()) {
          // Omitting text preserves every persisted delta when the renderer
          // folds this terminal item over the streamed version.
          const { text: _streamedText, ...started } = item
          this.#appendEvent(
            threadId,
            { type: 'item.completed', item: { ...started, status: 'failed' } },
            at,
          )
        }
        for (const id of state.approvals) {
          this.#appendEvent(threadId, { type: 'approval.resolved', id }, at)
        }
        for (const id of state.userInputs) {
          this.#appendEvent(threadId, { type: 'user_input.resolved', id }, at)
        }
        for (const review of state.reviews.values()) {
          if (review.status !== 'in_progress') continue
          this.#appendEvent(
            threadId,
            {
              type: 'approval.review.completed',
              review: { ...review, status: 'aborted', completedAt: at },
            },
            at,
          )
        }
        if (state.openTurns.size === 0) continue
        for (const turnId of state.openTurns) {
          this.#appendEvent(threadId, { type: 'turn.completed', turnId, status: 'interrupted' }, at)
        }
        if (!state.hasResumableInput) {
          this.#appendEvent(
            threadId,
            { type: 'thread.error', threadId, message: RESTART_INTERRUPTION_MESSAGE },
            at,
          )
        }
        this.touchThread(threadId, true, at)
        recovered.push(threadId)
      }
      this.#db.exec('COMMIT')
      return recovered
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Returns the sequence number, which is what a client resumes from. */
  append(threadId: string, event: DomainEvent): number {
    const at = Date.now()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const seq = this.#appendEvent(threadId, event, at)
      this.#db.exec('COMMIT')
      return seq
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  hasItem(threadId: string, itemId: string): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM events
           WHERE thread_id = ? AND json_extract(payload, '$.item.id') = ? LIMIT 1`,
        )
        .get(threadId, itemId) !== undefined
    )
  }

  #appendEvent(threadId: string, event: DomainEvent, at: number): number {
    const result = this.#insertEvent.run(threadId, at, JSON.stringify(event))
    const seq = Number(result.lastInsertRowid)
    if (!this.#ephemeralThreads.has(threadId)) this.#indexEvent(seq, threadId, at, event)
    return seq
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
        const { seq, payload } = SqliteHistoryRowSchema.parse(row)
        return { seq, event: DomainEventSchema.parse(JSON.parse(payload)) }
      })
  }

  /** The final provider-owned patch shown for one turn. */
  turnDiff(threadId: string, turnId: string): string | undefined {
    const rawRow = this.#db
      .prepare(
        `SELECT payload FROM events
         WHERE thread_id = ?
           AND json_extract(payload, '$.type') = 'diff.updated'
           AND json_extract(payload, '$.turnId') = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId, turnId)
    if (!rawRow) return undefined
    const row = SqlitePayloadRowSchema.parse(rawRow)
    const event = DomainEventSchema.parse(JSON.parse(row.payload))
    return event.type === 'diff.updated' ? event.diff : undefined
  }

  searchSessions(options: SessionSearchOptions): SessionSearchPage {
    const requestedLimit = options.limit ?? 25
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 25
    const ftsQuery = toFtsQuery(options.query)
    if (!ftsQuery) return { results: [], nextCursor: null }
    const cursor = decodeCursor(options.cursor)
    const clauses = ['session_search MATCH ?']
    const parameters: Array<string | number> = [ftsQuery]

    if (options.projectPath) {
      clauses.push('threads.project_path = ?')
      parameters.push(options.projectPath)
    }
    if (options.provider) {
      clauses.push('threads.provider = ?')
      parameters.push(options.provider)
    }

    const now = Date.now()
    this.#pruneSearchSnapshots(now, !cursor)
    const snapshotId = cursor?.snapshotId ?? randomUUID()
    if (cursor) {
      const rawSnapshot = this.#db
        .prepare(
          `SELECT fts_query, project_path, provider
           FROM session_search_snapshots
           WHERE id = ? AND expires_at > ?`,
        )
        .get(snapshotId, now)
      if (!rawSnapshot) throw new Error('Search results expired. Search again.')
      const snapshot = SqliteSearchSnapshotRowSchema.parse(rawSnapshot)
      const expected: SearchSnapshot = {
        ftsQuery,
        projectPath: options.projectPath ?? null,
        provider: options.provider ?? null,
      }
      if (
        snapshot.fts_query !== expected.ftsQuery ||
        snapshot.project_path !== expected.projectPath ||
        snapshot.provider !== expected.provider
      ) {
        throw new Error('Search cursor does not match this query.')
      }
      this.#db
        .prepare(`UPDATE session_search_snapshots SET expires_at = ? WHERE id = ?`)
        .run(now + SEARCH_SNAPSHOT_TTL_MS, snapshotId)
    } else {
      this.#db.exec('SAVEPOINT create_search_snapshot')
      try {
        this.#db
          .prepare(
            `INSERT INTO session_search_snapshots
               (id, fts_query, project_path, provider, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            snapshotId,
            ftsQuery,
            options.projectPath ?? null,
            options.provider ?? null,
            now + SEARCH_SNAPSHOT_TTL_MS,
          )
        this.#db
          .prepare(
            `INSERT INTO session_search_snapshot_rows
               (snapshot_id, search_rowid, snippet)
             SELECT ?, session_search.rowid,
                    snippet(session_search, 4, ?, ?, ' … ', 24)
             FROM session_search
             JOIN threads ON threads.id = session_search.thread_id
             JOIN projects ON projects.path = threads.project_path
             WHERE ${clauses.join(' AND ')}
             ORDER BY bm25(session_search), session_search.created_at DESC,
                      session_search.rowid DESC`,
          )
          .run(snapshotId, SNIPPET_START, SNIPPET_END, ...parameters)
        this.#db.exec('RELEASE create_search_snapshot')
      } catch (error) {
        this.#db.exec('ROLLBACK TO create_search_snapshot')
        this.#db.exec('RELEASE create_search_snapshot')
        throw error
      }
    }

    const position = cursor?.position ?? 0
    const rows = z.array(SqliteSearchResultRowSchema).parse(
      this.#db
        .prepare(
          `SELECT projects.path AS project_path, projects.name AS project_name,
                 threads.id AS thread_id, threads.title AS thread_title,
                 threads.provider, session_search.event_seq, session_search.turn_id,
                 session_search.created_at,
                 snapshot.position,
                 snapshot.snippet
         FROM session_search_snapshot_rows AS snapshot
         JOIN session_search ON session_search.rowid = snapshot.search_rowid
         JOIN threads ON threads.id = session_search.thread_id
         JOIN projects ON projects.path = threads.project_path
         WHERE snapshot.snapshot_id = ? AND snapshot.position > ?
         ORDER BY snapshot.position
         LIMIT ?`,
        )
        .all(snapshotId, position, limit + 1),
    )

    const page = rows.slice(0, limit)
    const resultIds = encodeSearchResultIds(
      this.#searchResultKey,
      page.map((row) => Number(row.event_seq)),
    )
    const last = page.at(-1)
    return {
      results: page.map((row, index) => ({
        resultId: resultIds[index]!,
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
              snapshotId,
              position: Number(last.position),
            })
          : null,
    }
  }

  #pruneSearchSnapshots(now: number, reserveSlot: boolean): void {
    const expired = this.#db
      .prepare(`SELECT id FROM session_search_snapshots WHERE expires_at <= ?`)
      .all(now)
      .map((row) => SqliteIdentifierRowSchema.parse(row).id)
    const active = this.#db
      .prepare(`SELECT id FROM session_search_snapshots ORDER BY expires_at DESC`)
      .all()
      .map((row) => SqliteIdentifierRowSchema.parse(row).id)
    const retainedCount = MAX_SEARCH_SNAPSHOTS - (reserveSlot ? 1 : 0)
    const overflow = active.slice(retainedCount)
    for (const snapshotId of new Set([...expired, ...overflow])) {
      this.#db
        .prepare(`DELETE FROM session_search_snapshot_rows WHERE snapshot_id = ?`)
        .run(snapshotId)
      this.#db.prepare(`DELETE FROM session_search_snapshots WHERE id = ?`).run(snapshotId)
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
        const rows = z.array(SqliteEventRowSchema).parse(batch.all(cursor))
        if (rows.length === 0) break
        for (const row of rows) {
          this.#indexEvent(
            row.seq,
            row.thread_id,
            row.at,
            DomainEventSchema.parse(JSON.parse(row.payload)),
          )
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
    const rows = z.array(SqliteUsageEventRowSchema).parse(
      this.#db
        .prepare(
          `SELECT e.thread_id, e.at, e.payload, t.provider
         FROM events e JOIN threads t ON t.id = e.thread_id
         WHERE e.payload LIKE '%"usage.updated"%'
         ORDER BY e.thread_id, e.seq`,
        )
        .all(),
    )

    const events: StoredUsageEvent[] = []
    for (const row of rows) {
      const event = DomainEventSchema.parse(JSON.parse(row.payload))
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

  usageSummary(threadId: string, since: number): UsageSummary {
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
    const parseUsage = (payload: string): UsageSample | undefined => {
      const event = DomainEventSchema.parse(JSON.parse(payload))
      return event.type === 'usage.updated'
        ? { total: withoutContext(event.usage), cumulative: event.usage.cumulative === true }
        : undefined
    }

    let session = emptyUsage()
    {
      const rows = z.array(SqlitePayloadRowSchema).parse(
        this.#db
          .prepare(
            `SELECT payload FROM events
           WHERE thread_id = ? AND payload LIKE '%"usage.updated"%' ORDER BY seq`,
          )
          .all(threadId),
      )
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
      const seeds = z.array(SqliteThreadPayloadRowSchema).parse(
        this.#db
          .prepare(
            `SELECT e.thread_id, e.payload
           FROM events e
           JOIN (SELECT thread_id, MAX(seq) AS seq FROM events
                 WHERE payload LIKE '%"usage.updated"%' AND at < ? GROUP BY thread_id) last
             ON e.thread_id = last.thread_id AND e.seq = last.seq`,
          )
          .all(since),
      )
      for (const seed of seeds) {
        const usage = parseUsage(seed.payload)
        if (usage?.cumulative) previous.set(seed.thread_id, usage.total)
      }

      const rows = z.array(SqliteThreadPayloadRowSchema).parse(
        this.#db
          .prepare(
            `SELECT e.thread_id, e.payload, t.provider
           FROM events e JOIN threads t ON t.id = e.thread_id
           WHERE e.at >= ? AND e.payload LIKE '%"usage.updated"%'
           ORDER BY e.thread_id, e.seq`,
          )
          .all(since),
      )
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
        const r = SqliteCheckpointRowSchema.parse(row)
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
    const rawRow = this.#db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id)
    if (!rawRow) return undefined
    const row = SqliteCheckpointRowSchema.parse(rawRow)
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
    const rawRow = this.#db
      .prepare(`SELECT snapshot_commit FROM restore_undos WHERE thread_id = ? AND token = ?`)
      .get(threadId, token)
    if (!rawRow) return undefined
    const row = z.object({ snapshot_commit: z.string() }).parse(rawRow)
    return { commit: row.snapshot_commit }
  }

  /** Put back the exact event/checkpoint rows removed by the latest restore. */
  applyRestoreUndo(threadId: string, token: string): void {
    const rawRow = this.#db
      .prepare(`SELECT * FROM restore_undos WHERE thread_id = ? AND token = ?`)
      .get(threadId, token)
    if (!rawRow) throw new Error('restore can no longer be undone')
    const row = SqliteRestoreUndoRowSchema.parse(rawRow)
    if (this.lastSeq(threadId) > Number(row.checkpoint_seq)) {
      throw new Error('restore can only be undone before the session continues')
    }

    const events = z.array(SqliteEventRowSchema).parse(JSON.parse(row.events_json))
    const checkpoints = z.array(SqliteCheckpointRowSchema).parse(JSON.parse(row.checkpoints_json))

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
          DomainEventSchema.parse(JSON.parse(event.payload)),
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
    const rawRow = this.#db
      .prepare(`SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?`)
      .get(threadId)
    const seq = rawRow ? SqliteMaxSequenceRowSchema.parse(rawRow).seq : null
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

function encodeSearchResultIds(key: Buffer, eventSeqs: number[]): string[] {
  const source = Buffer.alloc(eventSeqs.length * 16)
  for (const [index, eventSeq] of eventSeqs.entries()) {
    source[index * 16] = 1
    source.writeBigUInt64BE(BigInt(eventSeq), index * 16 + 8)
  }
  const cipher = createCipheriv('aes-256-ecb', key, null)
  cipher.setAutoPadding(false)
  const encoded = Buffer.concat([cipher.update(source), cipher.final()])
  return eventSeqs.map(
    (_, index) => `sr1_${encoded.subarray(index * 16, (index + 1) * 16).toString('base64url')}`,
  )
}

function toFtsQuery(query: string): string | undefined {
  const terms = query.normalize('NFKC').toLowerCase().match(SEARCH_TOKEN) ?? []
  const uniqueTerms = [...new Set(terms)]
  if (uniqueTerms.length === 0) return undefined
  return uniqueTerms.map((term) => `("${term}" OR "${term}"*)`).join(' AND ')
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(cursor: string | undefined): SearchCursor | undefined {
  if (!cursor) return undefined
  try {
    return SearchCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
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
    ...propertiesWhen(hasCost, () => ({ costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) })),
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
    ...propertiesWhen(!(costUsd === undefined), () => ({ costUsd })),
  }
}

function toProject(row: SqliteRow): StoredProject {
  const r = SqliteProjectRowSchema.parse(row)
  return {
    path: r.path,
    name: r.name,
    pinned: r.pinned === 1,
    createdAt: Number(r.created_at),
  }
}

function toQueuedTurn(row: SqliteRow): StoredQueuedTurn {
  const r = SqliteQueuedTurnRowSchema.parse(row)
  const payload = SqliteQueuedTurnPayloadSchema.parse(JSON.parse(r.payload))
  return {
    id: r.queue_id,
    threadId: r.thread_id,
    ...propertiesWhen(
      r.client_submission_id === null ? undefined : { clientSubmissionId: r.client_submission_id },
      (includedSubmission) => includedSubmission,
    ),
    text: payload.text,
    attachments: payload.attachments,
    options: payload.options,
    createdAt: Number(r.created_at),
    intent: r.intent,
  }
}

function toThread(row: SqliteRow): StoredThread {
  const r = SqliteThreadRowSchema.parse(row)
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
            ...propertiesWhen(
              r.woke_at === null ? undefined : { wokeAt: Number(r.woke_at) },
              (includedWokeAt) => includedWokeAt,
            ),
          }
  return {
    id: r.id,
    projectPath: r.project_path,
    provider: r.provider,
    ...propertiesWhen(
      r.agent === null ? undefined : { agent: r.agent },
      (includedAgent) => includedAgent,
    ),
    title: r.title,
    pinned: r.pinned === 1,
    createdAt: Number(r.created_at),
    ...propertiesWhen(
      r.closed_at === null ? undefined : { closedAt: Number(r.closed_at) },
      (includedClosedAt) => includedClosedAt,
    ),
    ...propertiesWhen(
      r.worktree_path === null ? undefined : { worktreePath: r.worktree_path },
      (includedWorktreePath) => includedWorktreePath,
    ),
    ...propertiesWhen(
      r.worktree_branch === null ? undefined : { worktreeBranch: r.worktree_branch },
      (includedWorktreeBranch) => includedWorktreeBranch,
    ),
    lifecycle,
    unread: r.unread === 1,
    lastActiveAt: Number(r.last_active_at),
    ephemeral: r.ephemeral === 1,
    ...propertiesWhen(
      r.parent_thread_id === null ? undefined : { parentThreadId: r.parent_thread_id },
      (includedParentThreadId) => includedParentThreadId,
    ),
  }
}

function serializeJson<T>(value: T): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('value cannot be stored as JSON')
  JsonValueSchema.parse(JSON.parse(serialized))
  return serialized
}
