import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import {
  ApprovalModeSchema,
  BackgroundModelPreferenceSchema,
  DiffDecisionSchema,
  DomainEventSchema,
  ProviderIdSchema,
  SidebarSettingsSchema,
} from '@harness/contracts'
import type {
  ApprovalMode,
  BackgroundModelPreference,
  DiffDecision,
  DomainEvent,
  JsonValue,
  ProviderId,
  ProviderHistorySession,
  SidebarSettings,
  SessionSearchResult,
  ThreadLifecycle,
  Usage,
} from '@harness/contracts'
import { z } from 'zod'
import type { TurnOptions } from './adapters.js'
import { canonicalDataPath } from './data-lease.js'
import { DatabaseSync, type SQLInputValue, type StatementSync } from './sqlite.js'
import {
  affectsInboxProjection,
  applyInboxProjectionEvent,
  emptyInboxProjection,
  isEmptyInboxProjection,
  type InboxProjection,
} from './inbox-projection.js'

const BACKGROUND_MODEL_SETTING = 'background-model'
const AUTOMATIC_BACKGROUND_MODEL_PREFERENCE: BackgroundModelPreference = Object.freeze({
  mode: 'automatic',
})

function freezeBackgroundModelPreference(
  preference: BackgroundModelPreference,
): BackgroundModelPreference {
  if (preference.mode === 'automatic') return AUTOMATIC_BACKGROUND_MODEL_PREFERENCE
  return Object.freeze({ ...preference, target: Object.freeze({ ...preference.target }) })
}

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
  /** Opaque provider-owned resume identity. Never used as the TasteCode id. */
  providerSessionId?: string | undefined
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

/** Only the fields sent by `projects.list`; recovery-only metadata stays in SQLite. */
export type StoredSidebarThread = {
  id: string
  projectPath: string
  provider: ProviderId
  agent?: string | undefined
  title: string
  pinned: boolean
  createdAt: number
  closedAt?: number | undefined
  worktreeBranch?: string | undefined
  lifecycle: ThreadLifecycle
  unread: boolean
}

type SidebarThreadUpdate = (thread: StoredSidebarThread) => StoredSidebarThread

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

export type SerializedEventAppend = { seq: number; serializedEvent: string }

type SearchCursor = {
  snapshotId: string
  position: number
}

type SearchRowIds = number[] | Uint32Array

type SearchSnapshot = {
  ftsQuery: string
  terms: readonly string[]
  projectPath: string | null
  provider: ProviderId | null
  revision: number
  expiresAt: number
  rowIds: SearchRowIds
}

export type UsageSummary = { session: UsageTotal; today: UsageTotal }

type UsageSample = { total: UsageTotal; cumulative: boolean }

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

const SEARCH_INDEX_VERSION = 'session_search_v1'
const USAGE_INDEX_VERSION = 'usage_events_v1'
const INBOX_INDEX_VERSION = 'inbox_events_v2'
const USER_SUBMISSION_INDEX_VERSION = 'user_submission_items_v1'
const TURN_DIFF_INDEX_VERSION = 'turn_diff_events_v1'
const RECOVERY_STATE_VERSION = 'recovery_lifecycles_v1'
const SEARCH_RESULT_KEY_SETTING = 'search_result_key_v1'
const SEARCH_SNAPSHOT_TTL_MS = 5 * 60 * 1_000
// The renderer owns one active search. Keep a few recently used cursors for
// backtracking, but do not let abandoned broad queries retain dozens of packed
// result arrays for the full five-minute cursor lifetime.
const MAX_SEARCH_SNAPSHOTS = 8
const MAX_SEARCH_PAGE_SIZE = 100
const SEARCH_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*/gu
const ASCII_SEARCH_TOKEN = /^\p{ASCII}+$/u
const ASCII_SEARCH_TEXT = /^\p{ASCII}*$/u
const ASCII_COMPARABLE_SEARCH_TERM = /^[a-z0-9][a-z0-9_]*$/
const ASCII_FTS_SEARCH_TERM = /^[a-z0-9]+$/
const ASCII_FTS_TEXT_TOKEN = /[a-z0-9]+/g
const SEARCH_COMBINING_MARK = /\p{M}/gu
const ASCII_SNIPPET_SCAN_THRESHOLD = 4_096
const SEARCH_SNAPSHOT_REUSE_SCAN_LIMIT = 16_384

type SearchSnippetToken = { start: number; end: number; highlighted: boolean }

function parseSearchRowIds(serialized: string): SearchRowIds {
  const unpacked = JSON.parse(serialized) as number[]
  if (unpacked.length <= MAX_SEARCH_PAGE_SIZE) return unpacked
  const packed = new Uint32Array(unpacked.length)
  for (let index = 0; index < unpacked.length; index += 1) {
    const rowId = unpacked[index]!
    if (!Number.isInteger(rowId) || rowId < 0 || rowId > 0xffff_ffff) return unpacked
    packed[index] = rowId
  }
  return packed
}

function searchRowIdPage(rowIds: SearchRowIds, start: number, end: number): number[] {
  if (Array.isArray(rowIds)) return rowIds.slice(start, end)
  return Array.from(rowIds.subarray(start, end))
}

const LIFECYCLE_INDEXES = `
CREATE INDEX IF NOT EXISTS threads_due_snooze
  ON threads (wake_at)
  WHERE closed_at IS NULL AND lifecycle_state = 'snoozed' AND ephemeral = 0;
CREATE INDEX IF NOT EXISTS threads_inactive
  ON threads (last_active_at)
  WHERE closed_at IS NULL AND lifecycle_state = 'active' AND ephemeral = 0 AND keep_active = 0;
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
  provider_session_id TEXT,
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

CREATE TABLE IF NOT EXISTS provider_history (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  metadata TEXT NOT NULL,
  loaded_revision TEXT,
  PRIMARY KEY (provider, session_id)
);

CREATE TABLE IF NOT EXISTS provider_history_events (
  thread_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (thread_id, event_seq)
);
CREATE INDEX IF NOT EXISTS provider_history_event_seq ON provider_history_events (event_seq);

INSERT OR IGNORE INTO sidebar_settings (id, mode, auto_settle_days) VALUES (1, 'classic', 3);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  event_seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_events_thread_seq ON usage_events (thread_id, event_seq);
CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events (at);

CREATE TABLE IF NOT EXISTS inbox_events (
  event_seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  payload   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS inbox_events_thread_seq ON inbox_events (thread_id, event_seq);

CREATE TABLE IF NOT EXISTS user_submission_items (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, item_id)
);

CREATE TABLE IF NOT EXISTS turn_diff_events (
  event_seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_id   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS turn_diff_events_thread_turn_seq
  ON turn_diff_events (thread_id, turn_id, event_seq DESC);

CREATE TABLE IF NOT EXISTS recovery_lifecycles (
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  lifecycle_key TEXT NOT NULL,
  event_type    TEXT,
  started_seq   INTEGER REFERENCES events(seq) ON DELETE SET NULL,
  terminal_seq  INTEGER REFERENCES events(seq) ON DELETE SET NULL,
  payload       TEXT,
  PRIMARY KEY (thread_id, lifecycle_key)
);

CREATE INDEX IF NOT EXISTS recovery_lifecycles_open
  ON recovery_lifecycles (started_seq)
  WHERE started_seq IS NOT NULL AND terminal_seq IS NULL;

CREATE TABLE IF NOT EXISTS recovery_errors (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS checkpoint_repositories (
  path TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS restore_undos (
  token            TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL UNIQUE,
  checkpoint_seq   INTEGER NOT NULL,
  snapshot_commit  TEXT NOT NULL,
  events_json      TEXT NOT NULL,
  checkpoints_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_replay_snapshots (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  payload   TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS thread_approvals (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  mode TEXT NOT NULL
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
  { table: 'threads', column: 'provider_session_id', definition: 'TEXT' },
]

type SqliteInteger = number | bigint
type ColumnRow = { name: string }
type StringValueRow = { value: string }
type MigrationRow = { name: string }
type ProjectRow = { path: string; name: string; pinned: SqliteInteger; created_at: SqliteInteger }
type WorktreeRow = {
  id: string
  project_path: string
  worktree_path: string
  worktree_branch: string
}
type ThreadRow = {
  id: string
  project_path: string
  provider: string
  agent: string | null
  provider_session_id: string | null
  title: string
  pinned: SqliteInteger
  created_at: SqliteInteger
  closed_at: SqliteInteger | null
  worktree_path: string | null
  worktree_branch: string | null
  lifecycle_state: string
  lifecycle_at: SqliteInteger | null
  lifecycle_reason: string | null
  wake_at: SqliteInteger | null
  keep_active: SqliteInteger
  woke_at: SqliteInteger | null
  unread: SqliteInteger
  last_active_at: SqliteInteger
  ephemeral: SqliteInteger
  parent_thread_id: string | null
}
type SidebarThreadRow = Pick<
  ThreadRow,
  | 'id'
  | 'project_path'
  | 'provider'
  | 'agent'
  | 'title'
  | 'pinned'
  | 'created_at'
  | 'closed_at'
  | 'worktree_branch'
  | 'lifecycle_state'
  | 'lifecycle_at'
  | 'lifecycle_reason'
  | 'wake_at'
  | 'keep_active'
  | 'woke_at'
  | 'unread'
>
type InactiveThreadCandidateRow = Pick<ThreadRow, 'id' | 'unread'>
type ThreadIdRow = Pick<ThreadRow, 'id'>
type ThreadLifecycleRow = Pick<
  ThreadRow,
  | 'lifecycle_state'
  | 'lifecycle_at'
  | 'lifecycle_reason'
  | 'wake_at'
  | 'keep_active'
  | 'woke_at'
  | 'created_at'
>
type SidebarSettingsRow = { mode: string; auto_settle_days: SqliteInteger | null }
const StoredTurnOptionsSchema = z.object({
  model: z.string().optional(),
  serviceTier: z.string().optional(),
  effort: z.string().optional(),
})
const StoredQueuedTurnPayloadSchema = z.object({
  text: z.string(),
  attachments: z.array(z.string()),
  options: StoredTurnOptionsSchema,
})
type QueuedTurnRow = {
  thread_id: string
  queue_id: string
  client_submission_id: string | null
  intent: string
  payload: string
  created_at: SqliteInteger
}
type PositionRow = { position: SqliteInteger }
type AdjacentQueuedTurnRow = { queue_id: string; position: SqliteInteger }
type QueuedTurnClaimRow = { thread_id: string; queue_id: string; intent: string }
type DiffDecisionRow = { decision: string }
type InterruptedThreadRow = { thread_id: string; payload: string; resumable: SqliteInteger }
type HistoryRow = { seq: SqliteInteger; payload: string }
type ThreadEventRow = { thread_id: string; payload: string }
type PayloadRow = { payload: string }
type SearchRowIdsRow = { search_rowids: string }
type SearchResultRow = {
  project_path: string
  project_name: string
  thread_id: string
  thread_title: string
  provider: string
  event_seq: SqliteInteger
  turn_id: string
  created_at: SqliteInteger
  position: SqliteInteger
  text: string
}
type EventRow = { seq: SqliteInteger; thread_id: string; at: SqliteInteger; payload: string }
type ThreadPayloadRow = { thread_id: string; payload: string }
type SearchableEntry = { turnId: string; createdAt?: number | undefined; text: string }
type ActiveLifecycleRow = { woke_at: SqliteInteger | null; keep_active: SqliteInteger }
type RecoveryMutation =
  | { kind: 'start'; eventType: string; lifecycleKey: string }
  | { kind: 'terminal'; lifecycleKey: string }
  | { kind: 'error' }
type DerivedIndexRebuild = {
  search: boolean
  usage: boolean
  inbox: boolean
  userSubmission: boolean
  turnDiff: boolean
  recovery: boolean
}
type CheckpointRow = {
  id: SqliteInteger
  thread_id: string
  seq: SqliteInteger
  commit_sha: string
  label: string
  created_at: SqliteInteger
}
type RestoreUndoRow = {
  thread_id: string
  snapshot_commit: string
  checkpoint_seq: SqliteInteger
  events_json: string
  checkpoints_json: string
}
type SnapshotCommitRow = { snapshot_commit: string }
type MaxSequenceRow = { seq: SqliteInteger | null }
type MinTimestampRow = { at: SqliteInteger | null }
type ReplaySnapshotRow = { seq: SqliteInteger; payload: string }
type ReplayEntry = { seq: number; event: DomainEvent }

/** Keep hot thread metadata without retaining every thread in a large workspace. */
const THREAD_CACHE_LIMIT = 128
// Count and bytes are separate: many short threads should not evict one another,
// while the character budget still bounds the parsed replay payloads.
const REPLAY_SNAPSHOT_CACHE_LIMIT = 64
const REPLAY_SNAPSHOT_CACHE_CHARACTER_LIMIT = 16 * 1024 * 1024

const StoredEventRowsSchema = z.array(
  z.object({
    seq: z.number().safe().int(),
    thread_id: z.string(),
    at: z.number().safe().int(),
    payload: z.string(),
  }),
)
const StoredCheckpointRowsSchema = z.array(
  z.object({
    id: z.number().safe().int(),
    thread_id: z.string(),
    seq: z.number().safe().int(),
    commit_sha: z.string(),
    label: z.string(),
    created_at: z.number().safe().int(),
  }),
)
const ReplaySnapshotSchema = z.array(
  z.object({ seq: z.number().safe().int(), event: DomainEventSchema }),
)
const SearchCursorSchema = z.object({
  snapshotId: z.string().min(1),
  position: z.number().safe().int().min(1),
})

export class Store {
  readonly checkpointNamespace: string
  readonly location: string
  #db: DatabaseSync
  #insertEvent: StatementSync
  #insertSearchEntry: StatementSync
  #insertUsageEvent: StatementSync
  #insertInboxEvent: StatementSync
  #deleteInboxStatus: StatementSync
  #deleteInboxRequest: StatementSync
  #deleteThreadInboxEvents: StatementSync
  #insertUserSubmission: StatementSync
  #hasUserSubmission: StatementSync
  #insertTurnDiffEvent: StatementSync
  #readTurnDiff: StatementSync
  #upsertRecoveryStart: StatementSync
  #settleRecoveryLifecycle: StatementSync
  #upsertRecoveryError: StatementSync
  #readInterruptedThreads: StatementSync
  #insertQueuedTurnEvent: StatementSync
  #listQueuedTurns: StatementSync
  #hasQueuedSubmission: StatementSync
  #openThread: StatementSync
  #nextQueuedPosition: StatementSync
  #insertQueuedTurn: StatementSync
  #deleteQueuedTurn: StatementSync
  #queuedTurnPosition: StatementSync
  #previousQueuedTurn: StatementSync
  #nextQueuedTurn: StatementSync
  #swapQueuedTurnPositions: StatementSync
  #findQueuedTurn: StatementSync
  #dispatchQueuedTurn: StatementSync
  #restoreQueuedTurn: StatementSync
  #claimedQueuedTurn: StatementSync
  #deleteClaimedQueuedTurn: StatementSync
  #queuedTurnInState: StatementSync
  #hasQueuedTurn: StatementSync
  #clearQueuedTurnsStatement: StatementSync
  #insertProject: StatementSync
  #findProject: StatementSync
  #insertThread: StatementSync
  #listProjects: StatementSync
  #listProjectThreads: StatementSync
  #listThreads: StatementSync
  #listSidebarThreads: StatementSync
  #findThread: StatementSync
  #threadHistory: StatementSync
  #threadInboxEvents: StatementSync
  #queuedThreadIds: StatementSync
  #settleThreadStatement: StatementSync
  #settleInactiveThreadStatement: StatementSync
  #activateThreadStatement: StatementSync
  #wakeSnoozedThreadStatement: StatementSync
  #touchActiveThreadStatement: StatementSync
  #touchThreadStatement: StatementSync
  #dueSnoozedThreadIds: StatementSync
  #nextSnoozedThread: StatementSync
  #oldestActiveThread: StatementSync
  #inactiveThreadCandidates: StatementSync
  #readReplaySnapshotBase: StatementSync
  #readTailReplaySnapshot: StatementSync
  #writeReplaySnapshot: StatementSync
  #deleteReplaySnapshot: StatementSync
  #lastSequence: StatementSync
  #selectSearchSnapshot = new Map<number, StatementSync>()
  #readSearchResults: StatementSync
  #readSidebarSettings: StatementSync
  #writeSidebarSettings: StatementSync
  #readAppSetting: StatementSync
  #writeAppSetting: StatementSync
  #searchResultKey: Buffer
  #projectsCache: StoredProject[] | undefined
  #projectCache = new Map<string, StoredProject>()
  #queuedThreadIdsCache: Set<string> | undefined
  /** `null` is a retained miss; `undefined` means the key was never cached. */
  #threadCache = new Map<string, StoredThread | null>()
  #sidebarThreadsCache: StoredSidebarThread[] | undefined
  #sidebarThreadIndexes: Map<string, number> | undefined
  #sidebarThreadUpdateBatchDepth = 0
  #pendingSidebarThreads: StoredSidebarThread[] | undefined
  #sidebarSettingsCache: SidebarSettings | undefined
  #backgroundModelPreferenceCache: BackgroundModelPreference | undefined
  #replaySnapshotCache = new Map<
    string,
    { seq: number; entries: ReplayEntry[]; characters: number }
  >()
  #replaySnapshotCacheCharacters = 0
  /** Search cursors are process-local; retaining packed row IDs avoids a temp-table write per hit. */
  #searchSnapshots = new Map<string, SearchSnapshot>()
  /** Fresh searches may share ranked IDs only while the searchable event index is unchanged. */
  #searchRevision = 0
  /** Keeps the streamed-event path from querying SQLite just to skip search indexing. */
  #ephemeralThreads = new Set<string>()

  /** `:memory:` in tests; a file under the user's data directory in the app. */
  constructor(location: string) {
    if (location !== ':memory:') location = canonicalDataPath(location)
    this.location = location
    this.checkpointNamespace = createHash('sha256')
      .update(location === ':memory:' ? randomUUID() : path.resolve(location))
      .digest('hex')
      .slice(0, 32)
    if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true })
    this.#db = new DatabaseSync(location)
    // Without WAL a reader blocks a writer, and we do both on every turn.
    this.#db.exec('PRAGMA journal_mode = WAL')
    // Search and history are read-heavy once the event log grows. Mapping the
    // stable database pages avoids copying them through SQLite's small default
    // page cache; the OS still brings pages into physical memory on demand.
    this.#db.exec('PRAGMA mmap_size = 268435456')
    // FULL fsyncs the WAL on every commit — and append() commits per streamed
    // delta chunk. NORMAL only syncs at checkpoint; with WAL a crash can lose
    // the tail of the log but cannot corrupt the database, which is the right
    // trade for a local event log rebuilt from the agent on resume.
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(SCHEMA)
    this.#readSidebarSettings = this.#db.prepare(
      `SELECT mode, auto_settle_days FROM sidebar_settings WHERE id = 1`,
    )
    this.#writeSidebarSettings = this.#db.prepare(
      `UPDATE sidebar_settings SET mode = ?, auto_settle_days = ? WHERE id = 1`,
    )
    this.#readAppSetting = this.#db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    this.#writeAppSetting = this.#db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
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
    this.#insertUsageEvent = this.#db.prepare(
      `INSERT OR REPLACE INTO usage_events (event_seq, thread_id, at, payload)
       VALUES (?, ?, ?, ?)`,
    )
    this.#insertInboxEvent = this.#db.prepare(
      `INSERT OR REPLACE INTO inbox_events (event_seq, thread_id, payload) VALUES (?, ?, ?)`,
    )
    this.#deleteInboxStatus = this.#db.prepare(
      `DELETE FROM inbox_events
       WHERE thread_id = ?
         AND json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.type')
           IN ('thread.error', 'turn.completed')`,
    )
    this.#deleteInboxRequest = this.#db.prepare(
      `DELETE FROM inbox_events
       WHERE thread_id = ?
         AND json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.type') = ?
         AND json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.request.id') = ?`,
    )
    this.#deleteThreadInboxEvents = this.#db.prepare(`DELETE FROM inbox_events WHERE thread_id = ?`)
    this.#insertUserSubmission = this.#db.prepare(
      `INSERT OR IGNORE INTO user_submission_items (thread_id, item_id, event_seq)
       VALUES (?, ?, ?)`,
    )
    this.#hasUserSubmission = this.#db.prepare(
      `SELECT 1 FROM user_submission_items WHERE thread_id = ? AND item_id = ?`,
    )
    this.#insertTurnDiffEvent = this.#db.prepare(
      `INSERT OR REPLACE INTO turn_diff_events (event_seq, thread_id, turn_id)
       VALUES (?, ?, ?)`,
    )
    this.#readTurnDiff = this.#db.prepare(
      `SELECT events.payload
       FROM turn_diff_events
       INNER JOIN events ON events.seq = turn_diff_events.event_seq
       WHERE turn_diff_events.thread_id = ? AND turn_diff_events.turn_id = ?
       ORDER BY turn_diff_events.event_seq DESC LIMIT 1`,
    )
    this.#upsertRecoveryStart = this.#db.prepare(
      `INSERT INTO recovery_lifecycles
         (thread_id, lifecycle_key, event_type, started_seq, terminal_seq, payload)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT (thread_id, lifecycle_key) DO UPDATE SET
         event_type = excluded.event_type,
         started_seq = excluded.started_seq,
         payload = excluded.payload
       WHERE recovery_lifecycles.terminal_seq IS NULL`,
    )
    this.#settleRecoveryLifecycle = this.#db.prepare(
      `INSERT INTO recovery_lifecycles
         (thread_id, lifecycle_key, event_type, started_seq, terminal_seq, payload)
       VALUES (?, ?, NULL, NULL, ?, NULL)
       ON CONFLICT (thread_id, lifecycle_key) DO UPDATE SET
         event_type = NULL,
         started_seq = NULL,
         terminal_seq = excluded.terminal_seq,
         payload = NULL`,
    )
    this.#upsertRecoveryError = this.#db.prepare(
      `INSERT INTO recovery_errors (thread_id, event_seq) VALUES (?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET event_seq = excluded.event_seq`,
    )
    this.#readInterruptedThreads = this.#db.prepare(
      `SELECT recovery.thread_id, recovery.payload,
              CASE WHEN recovery.event_type = 'user_input.requested'
                AND EXISTS (
                  SELECT 1 FROM design_runs
                  WHERE design_runs.thread_id = recovery.thread_id
                    AND json_extract(
                      CASE WHEN json_valid(design_runs.payload) THEN design_runs.payload END,
                      '$.phase'
                    ) = 'brief'
                ) THEN 1 ELSE 0 END AS resumable
       FROM recovery_lifecycles AS recovery
       INNER JOIN threads ON threads.id = recovery.thread_id
       LEFT JOIN recovery_errors AS errors ON errors.thread_id = recovery.thread_id
       WHERE threads.closed_at IS NULL
         AND recovery.started_seq IS NOT NULL
         AND recovery.terminal_seq IS NULL
         AND recovery.payload IS NOT NULL
         AND (recovery.event_type <> 'turn.started' OR errors.event_seq IS NULL
              OR errors.event_seq < recovery.started_seq)
       ORDER BY recovery.started_seq`,
    )
    this.#insertQueuedTurnEvent = this.#db.prepare(
      `INSERT INTO queued_turn_events (thread_id, queue_id, at, mutation, payload)
       VALUES (?, ?, ?, ?, ?)`,
    )
    this.#listQueuedTurns = this.#db.prepare(
      `SELECT queued_turns.* FROM queued_turns
       INNER JOIN threads ON threads.id = queued_turns.thread_id
       WHERE queued_turns.thread_id = ? AND queued_turns.state = 'queued'
         AND threads.closed_at IS NULL
       ORDER BY queued_turns.position`,
    )
    this.#hasQueuedSubmission = this.#db.prepare(
      `SELECT 1 FROM queued_turns
       WHERE thread_id = ? AND client_submission_id = ? LIMIT 1`,
    )
    this.#openThread = this.#db.prepare(`SELECT 1 FROM threads WHERE id = ? AND closed_at IS NULL`)
    this.#nextQueuedPosition = this.#db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS position
       FROM queued_turns WHERE thread_id = ?`,
    )
    this.#insertQueuedTurn = this.#db.prepare(
      `INSERT INTO queued_turns
         (thread_id, queue_id, client_submission_id, position, state, intent, payload, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'normal', ?, ?)`,
    )
    this.#deleteQueuedTurn = this.#db.prepare(
      `DELETE FROM queued_turns WHERE thread_id = ? AND queue_id = ?`,
    )
    this.#queuedTurnPosition = this.#db.prepare(
      `SELECT position FROM queued_turns
       WHERE thread_id = ? AND queue_id = ? AND state = 'queued'`,
    )
    this.#previousQueuedTurn = this.#db.prepare(
      `SELECT queue_id, position FROM queued_turns
       WHERE thread_id = ? AND state = 'queued' AND position < ?
       ORDER BY position DESC LIMIT 1`,
    )
    this.#nextQueuedTurn = this.#db.prepare(
      `SELECT queue_id, position FROM queued_turns
       WHERE thread_id = ? AND state = 'queued' AND position > ?
       ORDER BY position ASC LIMIT 1`,
    )
    this.#swapQueuedTurnPositions = this.#db.prepare(
      `UPDATE queued_turns SET position = CASE queue_id WHEN ? THEN ? WHEN ? THEN ? END
       WHERE thread_id = ? AND queue_id IN (?, ?)`,
    )
    this.#findQueuedTurn = this.#db.prepare(
      `SELECT * FROM queued_turns
       WHERE thread_id = ? AND queue_id = ? AND state = 'queued'`,
    )
    this.#dispatchQueuedTurn = this.#db.prepare(
      `UPDATE queued_turns SET state = 'dispatching', intent = ?
       WHERE thread_id = ? AND queue_id = ?`,
    )
    this.#restoreQueuedTurn = this.#db.prepare(
      `UPDATE queued_turns SET state = 'queued', intent = 'normal'
       WHERE thread_id = ? AND queue_id = ?`,
    )
    this.#claimedQueuedTurn = this.#db.prepare(
      `SELECT 1 FROM queued_turns
       WHERE thread_id = ? AND queue_id = ? AND state = 'dispatching'`,
    )
    this.#deleteClaimedQueuedTurn = this.#db.prepare(
      `DELETE FROM queued_turns
       WHERE thread_id = ? AND queue_id = ? AND state = 'dispatching'`,
    )
    this.#queuedTurnInState = this.#db.prepare(
      `SELECT 1 FROM queued_turns WHERE thread_id = ? AND queue_id = ? AND state = ?`,
    )
    this.#hasQueuedTurn = this.#db.prepare(`SELECT 1 FROM queued_turns WHERE thread_id = ? LIMIT 1`)
    this.#clearQueuedTurnsStatement = this.#db.prepare(
      `DELETE FROM queued_turns WHERE thread_id = ?`,
    )
    this.#migrate()
    this.#db.exec(LIFECYCLE_INDEXES)
    this.#insertProject = this.#db.prepare(
      `INSERT INTO projects (path, name, pinned, created_at) VALUES (?, ?, 0, ?)
       ON CONFLICT (path) DO NOTHING`,
    )
    this.#findProject = this.#db.prepare(`SELECT * FROM projects WHERE path = ?`)
    this.#insertThread = this.#db.prepare(
      `INSERT INTO threads
        (id, project_path, provider, agent, provider_session_id, title, created_at,
          worktree_path, worktree_branch,
          lifecycle_state, keep_active, unread, last_active_at, ephemeral, parent_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?)`,
    )
    this.#listProjects = this.#db.prepare(`SELECT * FROM projects ORDER BY created_at`)
    this.#listProjectThreads = this.#db.prepare(
      `SELECT * FROM threads WHERE project_path = ? AND ephemeral = 0 ORDER BY created_at DESC`,
    )
    this.#listThreads = this.#db.prepare(
      `SELECT * FROM threads WHERE ephemeral = 0 ORDER BY created_at DESC`,
    )
    this.#listSidebarThreads = this.#db.prepare(
      `SELECT id, project_path, provider, agent, title, pinned, created_at, closed_at,
              worktree_branch, lifecycle_state, lifecycle_at, lifecycle_reason, wake_at,
              keep_active, woke_at, unread
       FROM threads WHERE ephemeral = 0 ORDER BY created_at DESC`,
    )
    for (let mask = 0; mask < 4; mask += 1) {
      const clauses = ['session_search MATCH ?']
      const threadFilters: string[] = []
      // Build the small eligible-thread set once instead of probing the thread
      // primary key for every FTS match. The visible page still joins metadata.
      if ((mask & 1) !== 0) threadFilters.push('threads.project_path = ?')
      if ((mask & 2) !== 0) threadFilters.push('threads.provider = ?')
      if (threadFilters.length > 0) {
        clauses.push(
          `session_search.thread_id IN (
             SELECT threads.id FROM threads WHERE ${threadFilters.join(' AND ')}
           )`,
        )
      }
      this.#selectSearchSnapshot.set(
        mask,
        this.#db.prepare(
          `SELECT json_group_array(search_rowid) AS search_rowids
           FROM (
             SELECT session_search.rowid AS search_rowid
             FROM session_search
             WHERE ${clauses.join(' AND ')}
             ORDER BY rank, session_search.created_at DESC,
                      session_search.rowid DESC
           )`,
        ),
      )
    }
    this.#readSearchResults = this.#db.prepare(
      `SELECT projects.path AS project_path, projects.name AS project_name,
              threads.id AS thread_id, threads.title AS thread_title,
              threads.provider, session_search.event_seq, session_search.turn_id,
              session_search.created_at,
              CAST(page.key AS INTEGER) + ? + 1 AS position,
              session_search.text
       FROM json_each(?) AS page
       JOIN session_search ON session_search.rowid = CAST(page.value AS INTEGER)
       JOIN threads ON threads.id = session_search.thread_id
       JOIN projects ON projects.path = threads.project_path
       ORDER BY CAST(page.key AS INTEGER)
       `,
    )
    this.#findThread = this.#db.prepare(`SELECT * FROM threads WHERE id = ?`)
    this.#threadHistory = this.#db.prepare(
      `SELECT e.seq, e.payload FROM events e
       LEFT JOIN provider_history_events p ON p.event_seq = e.seq
       WHERE e.thread_id = ? AND e.seq > ? AND (p.active IS NULL OR p.active = 1) ORDER BY e.seq`,
    )
    this.#threadInboxEvents = this.#db.prepare(
      `SELECT thread_id, payload FROM inbox_events ORDER BY event_seq`,
    )
    this.#queuedThreadIds = this.#db.prepare(
      `SELECT DISTINCT queued_turns.thread_id
       FROM queued_turns
       INNER JOIN threads ON threads.id = queued_turns.thread_id
       WHERE queued_turns.state = 'queued' AND threads.closed_at IS NULL`,
    )
    this.#settleThreadStatement = this.#db.prepare(
      `UPDATE threads SET lifecycle_state = 'settled', lifecycle_at = ?, lifecycle_reason = ?,
       wake_at = NULL, keep_active = 0, woke_at = NULL WHERE id = ? AND closed_at IS NULL`,
    )
    this.#settleInactiveThreadStatement = this.#db.prepare(
      `UPDATE threads SET lifecycle_state = 'settled', lifecycle_at = ?,
       lifecycle_reason = 'inactivity', wake_at = NULL, keep_active = 0, woke_at = NULL
       WHERE id = ? AND closed_at IS NULL AND lifecycle_state = 'active'
       AND ephemeral = 0 AND keep_active = 0 AND last_active_at <= ?`,
    )
    this.#activateThreadStatement = this.#db.prepare(
      `UPDATE threads SET lifecycle_state = 'active', lifecycle_at = NULL,
       lifecycle_reason = NULL, wake_at = NULL,
       woke_at = CASE WHEN lifecycle_state = 'active' THEN woke_at ELSE ? END
       WHERE id = ? RETURNING woke_at, keep_active`,
    )
    this.#wakeSnoozedThreadStatement = this.#db.prepare(
      `UPDATE threads SET lifecycle_state = 'active', lifecycle_at = NULL,
       lifecycle_reason = NULL, wake_at = NULL, woke_at = ?, last_active_at = ?
       WHERE id = ? AND closed_at IS NULL AND lifecycle_state = 'snoozed'
         AND ephemeral = 0 AND wake_at <= ? RETURNING woke_at, keep_active`,
    )
    this.#touchActiveThreadStatement = this.#db.prepare(
      `UPDATE threads SET last_active_at = ?, unread = MAX(unread, ?)
       WHERE id = ? AND closed_at IS NULL`,
    )
    this.#touchThreadStatement = this.#db.prepare(
      `UPDATE threads SET lifecycle_state = 'active', lifecycle_at = NULL,
       lifecycle_reason = NULL, wake_at = NULL,
       woke_at = CASE WHEN lifecycle_state = 'active' THEN woke_at ELSE ? END,
       last_active_at = ?, unread = MAX(unread, ?)
       WHERE id = ? AND closed_at IS NULL RETURNING woke_at, keep_active`,
    )
    this.#dueSnoozedThreadIds = this.#db.prepare(
      `SELECT id FROM threads WHERE closed_at IS NULL AND lifecycle_state = 'snoozed'
       AND ephemeral = 0 AND wake_at <= ? ORDER BY wake_at`,
    )
    this.#nextSnoozedThread = this.#db.prepare(
      `SELECT MIN(wake_at) AS at FROM threads
       WHERE closed_at IS NULL AND lifecycle_state = 'snoozed' AND ephemeral = 0`,
    )
    this.#oldestActiveThread = this.#db.prepare(
      `SELECT MIN(last_active_at) AS at FROM threads
       WHERE closed_at IS NULL AND lifecycle_state = 'active'
         AND ephemeral = 0 AND keep_active = 0`,
    )
    this.#inactiveThreadCandidates = this.#db.prepare(
      `SELECT id, unread FROM threads
       WHERE closed_at IS NULL AND lifecycle_state = 'active'
         AND ephemeral = 0 AND keep_active = 0 AND last_active_at <= ?
       ORDER BY last_active_at`,
    )
    this.#readReplaySnapshotBase = this.#db.prepare(
      `SELECT seq, payload FROM thread_replay_snapshots WHERE thread_id = ?`,
    )
    this.#readTailReplaySnapshot = this.#db.prepare(
      `SELECT snapshot.seq, snapshot.payload
       FROM thread_replay_snapshots AS snapshot
       WHERE snapshot.thread_id = ?
         AND snapshot.seq = COALESCE(
           (SELECT MAX(events.seq) FROM events WHERE events.thread_id = snapshot.thread_id),
           0
         )`,
    )
    this.#writeReplaySnapshot = this.#db.prepare(
      `INSERT INTO thread_replay_snapshots (thread_id, seq, payload) VALUES (?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET seq = excluded.seq, payload = excluded.payload`,
    )
    this.#deleteReplaySnapshot = this.#db.prepare(
      `DELETE FROM thread_replay_snapshots WHERE thread_id = ?`,
    )
    this.#lastSequence = this.#db.prepare(`SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?`)
    this.#purgeEphemeralThreads()
    this.#recoverQueuedTurnClaims()
    const completedMigrations = new Set(
      sqliteRows<MigrationRow>(this.#db.prepare(`SELECT name FROM schema_migrations`)).map(
        ({ name }) => name,
      ),
    )
    const rebuild: DerivedIndexRebuild = {
      search: !completedMigrations.has(SEARCH_INDEX_VERSION),
      usage: !completedMigrations.has(USAGE_INDEX_VERSION),
      inbox: !completedMigrations.has(INBOX_INDEX_VERSION),
      userSubmission: !completedMigrations.has(USER_SUBMISSION_INDEX_VERSION),
      turnDiff: !completedMigrations.has(TURN_DIFF_INDEX_VERSION),
      recovery: !completedMigrations.has(RECOVERY_STATE_VERSION),
    }
    if (Object.values(rebuild).some(Boolean)) this.#rebuildDerivedIndexes(rebuild)
  }

  /** Bring a database written by an older build up to the current shape. */
  #migrate(): void {
    const columnsByTable = new Map<string, Set<string>>()
    for (const { table, column, definition } of ADDED_COLUMNS) {
      let columns = columnsByTable.get(table)
      if (!columns) {
        columns = new Set(
          sqliteRows<ColumnRow>(this.#db.prepare(`PRAGMA table_info(${table})`)).map(
            (row) => row.name,
          ),
        )
        columnsByTable.set(table, columns)
      }
      if (columns.has(column)) continue
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      columns.add(column)
    }
    this.#db.exec(`UPDATE threads SET last_active_at = created_at WHERE last_active_at = 0`)
  }

  /** Side chats intentionally do not survive an app restart or a crashed renderer. */
  #purgeEphemeralThreads(): void {
    const exists = this.#db.prepare(`SELECT 1 FROM threads WHERE ephemeral = 1 LIMIT 1`).get()
    if (!exists) return
    this.#transaction(() => {
      this.#db.exec(`
        DELETE FROM session_search
        WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1);
        DELETE FROM events
        WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1);
        DELETE FROM checkpoints
        WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1);
        DELETE FROM restore_undos
        WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1);
        DELETE FROM diff_decisions
        WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1);
        DELETE FROM design_runs
        WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1);
        DELETE FROM threads WHERE ephemeral = 1;
      `)
    })
  }

  close(): void {
    this.#searchSnapshots.clear()
    this.#db.close()
  }

  #loadSearchResultKey(): Buffer {
    this.#db
      .prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`)
      .run(SEARCH_RESULT_KEY_SETTING, randomBytes(32).toString('base64url'))
    const row = requiredSqliteRow<StringValueRow>(this.#readAppSetting, SEARCH_RESULT_KEY_SETTING)
    const key = Buffer.from(row.value, 'base64url')
    if (key.length !== 32) throw new Error('Search result identity key is invalid.')
    return key
  }

  // ---- projects ----------------------------------------------------------

  addProject(projectPath: string, name?: string): StoredProject {
    const retained = this.#projectCache.get(projectPath)
    if (retained) return retained
    const project: StoredProject = {
      path: projectPath,
      name: name ?? path.basename(projectPath),
      pinned: false,
      createdAt: Date.now(),
    }
    // Adding a project twice is a normal thing for a user to do; it must not
    // wipe the name they gave it.
    const inserted = this.#insertProject.run(project.path, project.name, project.createdAt)
    if (Number(inserted.changes) > 0) {
      this.#projectsCache = undefined
      this.#projectCache.set(projectPath, project)
      return project
    }
    return this.project(projectPath) ?? project
  }

  setPinned(projectPath: string, pinned: boolean): void {
    this.#db
      .prepare(`UPDATE projects SET pinned = ? WHERE path = ?`)
      .run(pinned ? 1 : 0, projectPath)
    this.#projectsCache = undefined
    const retained = this.#projectCache.get(projectPath)
    if (retained) this.#projectCache.set(projectPath, { ...retained, pinned })
  }

  project(projectPath: string): StoredProject | undefined {
    const retained = this.#projectCache.get(projectPath)
    if (retained) return retained
    const row = sqliteRow<ProjectRow>(this.#findProject, projectPath)
    const project = row ? toProject(row) : undefined
    if (project) this.#projectCache.set(projectPath, project)
    return project
  }

  projects(): StoredProject[] {
    if (!this.#projectsCache) {
      this.#projectsCache = sqliteRows<ProjectRow>(this.#listProjects).map(toProject)
      for (const project of this.#projectsCache) this.#projectCache.set(project.path, project)
    }
    return this.#projectsCache
  }

  renameProject(projectPath: string, name: string): void {
    this.#db.prepare(`UPDATE projects SET name = ? WHERE path = ?`).run(name, projectPath)
    this.#projectsCache = undefined
    const retained = this.#projectCache.get(projectPath)
    if (retained) this.#projectCache.set(projectPath, { ...retained, name })
  }

  /** Hides the project from the sidebar. Re-adding it restores its chat history. */
  removeProject(projectPath: string): void {
    this.#db.prepare(`DELETE FROM projects WHERE path = ?`).run(projectPath)
    this.#projectsCache = undefined
    this.#projectCache.delete(projectPath)
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
    this.#insertThread.run(
      stored.id,
      stored.projectPath,
      stored.provider,
      stored.agent ?? null,
      stored.providerSessionId ?? null,
      stored.title,
      stored.createdAt,
      stored.worktreePath ?? null,
      stored.worktreeBranch ?? null,
      stored.createdAt,
      ephemeral ? 1 : 0,
      stored.parentThreadId ?? null,
    )
    if (ephemeral) this.#ephemeralThreads.add(stored.id)
    this.#invalidateSidebarThreads()
    const result = {
      ...stored,
      pinned: false,
      lifecycle,
      unread: false,
      lastActiveAt: stored.createdAt,
      ephemeral,
    }
    this.#cacheThread(stored.id, result)
    return result
  }

  /**
   * Every worktree we ever created and have not forgotten.
   *
   * Read at startup: a crash leaves directories behind that nobody remembers,
   * and the record here is the only thing that knows they exist.
   */
  worktrees(): Array<{ threadId: string; path: string; branch: string; repoPath: string }> {
    return sqliteRows<WorktreeRow>(
      this.#db.prepare(
        `SELECT id, project_path, worktree_path, worktree_branch FROM threads
                WHERE worktree_path IS NOT NULL AND ephemeral = 0`,
      ),
    ).map((row) => {
      return {
        threadId: row.id,
        path: row.worktree_path,
        branch: row.worktree_branch,
        repoPath: row.project_path,
      }
    })
  }

  addProviderThread(id: string, provider: ProviderId, session: ProviderHistorySession): void {
    const thread = this.addThread({
      id,
      provider,
      providerSessionId: session.id,
      projectPath: session.workspacePath,
      title: session.title || 'Untitled chat',
      createdAt: session.createdAt,
    })
    const closedAt = session.archived ? session.updatedAt : undefined
    this.#db
      .prepare('UPDATE threads SET closed_at = ?, last_active_at = ? WHERE id = ?')
      .run(closedAt ?? null, session.updatedAt, id)
    this.#cacheThread(id, { ...thread, closedAt, lastActiveAt: session.updatedAt })
  }

  forgetWorktree(threadId: string): void {
    this.#db
      .prepare(`UPDATE threads SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?`)
      .run(threadId)
    this.#updateCachedThread(threadId, (thread) => {
      if (thread.worktreePath === undefined && thread.worktreeBranch === undefined) return thread
      const { worktreePath: _worktreePath, worktreeBranch: _worktreeBranch, ...updated } = thread
      return updated
    })
    this.#updateSidebarThread(threadId, (thread) => {
      if (thread.worktreeBranch === undefined) return thread
      const { worktreeBranch: _worktreeBranch, ...updated } = thread
      return updated
    })
  }

  thread(id: string): StoredThread | undefined {
    const cached = this.#threadCache.get(id)
    if (cached !== undefined) return cached ?? undefined
    const row = sqliteRow<ThreadRow>(this.#findThread, id)
    const thread = row ? toThread(row) : undefined
    this.#cacheThread(id, thread)
    return thread
  }

  /** Newest first — the rail shows recent work at the top. */
  threads(projectPath?: string): StoredThread[] {
    const rows = projectPath
      ? sqliteRows<ThreadRow>(this.#listProjectThreads, projectPath)
      : sqliteRows<ThreadRow>(this.#listThreads)
    const threads: StoredThread[] = []
    for (const row of rows) {
      const thread = toThread(row)
      if (thread !== undefined) threads.push(thread)
    }
    return threads
  }

  /** Compact metadata for the sidebar's all-thread refresh. */
  sidebarThreads(): StoredSidebarThread[] {
    if (!this.#sidebarThreadsCache) {
      const threads: StoredSidebarThread[] = []
      for (const row of sqliteRows<SidebarThreadRow>(this.#listSidebarThreads)) {
        const thread = toSidebarThread(row)
        if (thread !== undefined) threads.push(thread)
      }
      this.#sidebarThreadsCache = threads
      this.#sidebarThreadIndexes = new Map(threads.map((thread, index) => [thread.id, index]))
    }
    this.#flushPendingSidebarThreads()
    return this.#sidebarThreadsCache
  }

  batchSidebarThreadUpdates<T>(operation: () => T): T {
    this.#sidebarThreadUpdateBatchDepth += 1
    try {
      return operation()
    } finally {
      this.#sidebarThreadUpdateBatchDepth -= 1
      if (this.#sidebarThreadUpdateBatchDepth === 0) this.#flushPendingSidebarThreads()
    }
  }

  batchLifecycleUpdates<T>(operation: () => T): T {
    return this.batchSidebarThreadUpdates(() => {
      try {
        return this.#transaction(operation)
      } catch (error) {
        this.#threadCache.clear()
        this.#projectCache.clear()
        this.#projectsCache = undefined
        this.#invalidateSidebarThreads()
        throw error
      }
    })
  }

  renameThread(id: string, title: string): void {
    this.#db.prepare(`UPDATE threads SET title = ? WHERE id = ?`).run(title, id)
    this.#updateCachedThread(id, (thread) =>
      thread.title === title ? thread : { ...thread, title },
    )
    this.#updateSidebarThread(id, (thread) =>
      thread.title === title ? thread : { ...thread, title },
    )
  }

  setThreadPinned(id: string, pinned: boolean): void {
    this.#db.prepare(`UPDATE threads SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id)
    this.#updateCachedThread(id, (thread) =>
      thread.pinned === pinned ? thread : { ...thread, pinned },
    )
    this.#updateSidebarThread(id, (thread) =>
      thread.pinned === pinned ? thread : { ...thread, pinned },
    )
  }

  /** Persist the provider's opaque resume identity as thread recovery metadata. */
  setProviderSessionId(id: string, providerSessionId: string): void {
    if (!providerSessionId) throw new Error('provider session id cannot be empty')
    this.#updateThread(
      id,
      `UPDATE threads SET provider_session_id = ? WHERE id = ?`,
      (thread) =>
        thread.providerSessionId === providerSessionId ? thread : { ...thread, providerSessionId },
      providerSessionId,
    )
  }

  providerHistories(): Array<{
    provider: ProviderId
    threadId: string
    session: ProviderHistorySession
    loadedRevision: string | null
  }> {
    return sqliteRows<{
      provider: string
      thread_id: string
      metadata: string
      loaded_revision: string | null
    }>(this.#db.prepare('SELECT * FROM provider_history')).map((row) => ({
      provider: ProviderIdSchema.parse(row.provider),
      threadId: row.thread_id,
      session: JSON.parse(row.metadata) as ProviderHistorySession,
      loadedRevision: row.loaded_revision,
    }))
  }

  /** Include temporary tasks so provider discovery cannot publish their internal prompts. */
  nativeProviderThreads(provider: ProviderId): StoredThread[] {
    return sqliteRows<ThreadRow>(
      this.#db.prepare("SELECT * FROM threads WHERE provider = ? AND id NOT LIKE 'external:%'"),
      provider,
    ).flatMap((row) => {
      const thread = toThread(row)
      return thread ? [thread] : []
    })
  }

  providerHistoryChangedAfter(threadId: string, seq: number): boolean {
    return (
      this.#db
        .prepare(
          'SELECT 1 FROM provider_history_events WHERE thread_id = ? AND event_seq > ? LIMIT 1',
        )
        .get(threadId, seq) !== undefined
    )
  }

  saveProviderHistory(
    provider: ProviderId,
    threadId: string,
    session: ProviderHistorySession,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO provider_history (provider, session_id, thread_id, metadata)
      VALUES (?, ?, ?, ?) ON CONFLICT(provider, session_id) DO UPDATE SET
        metadata = excluded.metadata,
        loaded_revision = CASE WHEN provider_history.thread_id = excluded.thread_id
          THEN provider_history.loaded_revision ELSE NULL END,
        thread_id = excluded.thread_id`,
      )
      .run(provider, session.id, threadId, JSON.stringify(session))
    const thread = this.thread(threadId)
    if (thread && Number.isFinite(session.updatedAt) && session.updatedAt > thread.lastActiveAt) {
      this.#db
        .prepare('UPDATE threads SET last_active_at = ? WHERE id = ?')
        .run(session.updatedAt, threadId)
      this.#updateCachedThread(threadId, (current) => ({
        ...current,
        lastActiveAt: session.updatedAt,
      }))
      this.#updateSidebarThread(threadId, (current) => ({
        ...current,
        lastActiveAt: session.updatedAt,
      }))
    }
  }

  /** Only locally recorded events, used to identify provider echoes of our own turns. */
  localHistory(threadId: string): Array<{ seq: number; event: DomainEvent }> {
    return sqliteRows<HistoryRow>(
      this.#db.prepare(`SELECT e.seq, e.payload FROM events e
      LEFT JOIN provider_history_events p ON p.event_seq = e.seq
      WHERE e.thread_id = ? AND p.event_seq IS NULL ORDER BY e.seq`),
      threadId,
    ).flatMap((row) => {
      const event = parseDomainEvent(row.payload, `local history for thread ${threadId}`)
      return event === undefined ? [] : [{ seq: Number(row.seq), event }]
    })
  }

  /** Keep stable log positions so imported updates cannot invalidate local checkpoints. */
  mergeProviderHistory(
    threadId: string,
    revision: string,
    entries: Array<{ key: string; event: DomainEvent }>,
  ): boolean {
    const previous = new Map(
      sqliteRows<{ event_key: string; event_seq: number; payload: string; active: number }>(
        this.#db
          .prepare(`SELECT p.event_key, p.event_seq, p.active, e.payload FROM provider_history_events p
        JOIN events e ON e.seq = p.event_seq WHERE p.thread_id = ? ORDER BY p.event_seq`),
        threadId,
      ).map((row) => [row.event_key, row]),
    )
    const link = this.#db.prepare(
      'INSERT INTO provider_history_events (thread_id, event_key, event_seq) VALUES (?, ?, ?)',
    )
    let changed = false
    this.#transaction(() => {
      const keys = JSON.stringify(entries.map(({ key }) => key))
      const retired = this.#db
        .prepare(
          `UPDATE provider_history_events SET active = 0
        WHERE thread_id = ? AND active = 1 AND event_key NOT IN (SELECT value FROM json_each(?))`,
        )
        .run(threadId, keys).changes
      if (retired) changed = true
      let turnAt = this.thread(threadId)?.createdAt ?? 0
      for (const { key, event } of entries) {
        const payload = JSON.stringify(event)
        const existing = previous.get(key)
        if (event.type === 'turn.started') turnAt = event.turn.createdAt
        if (
          existing?.active &&
          existing.payload === payload &&
          !(retired && event.type === 'thread.started')
        )
          continue
        if (existing)
          this.#db
            .prepare(
              'UPDATE provider_history_events SET active = 0 WHERE thread_id = ? AND event_key = ?',
            )
            .run(threadId, key)
        const at =
          event.type === 'item.completed' || event.type === 'item.started'
            ? event.item.createdAt
            : event.type === 'turn.started'
              ? event.turn.createdAt
              : turnAt
        const seq = this.#appendEventPayload(threadId, event, at, payload)
        link.run(threadId, key, seq)
        previous.set(key, { event_key: key, event_seq: seq, payload, active: 1 })
        changed = true
      }
      this.#db
        .prepare('UPDATE provider_history SET loaded_revision = ? WHERE thread_id = ?')
        .run(revision, threadId)
      if (changed) {
        this.#db
          .prepare(
            `DELETE FROM session_search WHERE rowid IN
          (SELECT event_seq FROM provider_history_events WHERE thread_id = ? AND active = 0)`,
          )
          .run(threadId)
        this.#db
          .prepare(
            `DELETE FROM usage_events WHERE event_seq IN
          (SELECT event_seq FROM provider_history_events WHERE thread_id = ? AND active = 0)`,
          )
          .run(threadId)
        this.#searchRevision += 1
        this.#deleteReplaySnapshot.run(threadId)
        this.#deleteCachedReplaySnapshot(threadId)
        this.#rebuildThreadInboxState(threadId)
        this.#rebuildThreadRecoveryState(threadId)
      }
    })
    return changed
  }

  settleThread(
    id: string,
    reason: 'manual' | 'inactivity' | 'change_request',
    at = Date.now(),
  ): ThreadLifecycle {
    const lifecycle = { state: 'settled' as const, settledAt: at, reason }
    const result = this.#settleThreadStatement.run(at, reason, id)
    if (result.changes === 0) throw new Error('thread not found')
    this.#updateCachedThread(id, (thread) => ({ ...thread, lifecycle }))
    this.#updateSidebarThread(id, (thread) => ({ ...thread, lifecycle }))
    return lifecycle
  }

  settleInactiveThread(id: string, cutoff: number, at = Date.now()): ThreadLifecycle | undefined {
    const lifecycle = { state: 'settled' as const, settledAt: at, reason: 'inactivity' as const }
    const result = this.#settleInactiveThreadStatement.run(at, id, cutoff)
    if (result.changes === 0) return undefined
    this.#updateCachedThread(id, (thread) => ({ ...thread, lifecycle }))
    this.#updateSidebarThread(id, (thread) => ({ ...thread, lifecycle }))
    return lifecycle
  }

  snoozeThread(id: string, wakeAt: number, at = Date.now()): ThreadLifecycle {
    const lifecycle = { state: 'snoozed' as const, snoozedAt: at, wakeAt }
    this.#updateThread(
      id,
      `UPDATE threads SET lifecycle_state = 'snoozed', lifecycle_at = ?,
       lifecycle_reason = NULL, wake_at = ?, keep_active = 0, woke_at = NULL
       WHERE id = ? AND closed_at IS NULL`,
      (thread) => ({ ...thread, lifecycle }),
      at,
      wakeAt,
    )
    this.#updateSidebarThread(id, (thread) => ({ ...thread, lifecycle }))
    return lifecycle
  }

  activateThread(id: string, at = Date.now()): ThreadLifecycle {
    const row = sqliteRow<ActiveLifecycleRow>(this.#activateThreadStatement, at, id)
    if (!row) throw new Error('thread not found')
    const lifecycle = toActiveLifecycle(row)
    this.#updateCachedThread(id, (thread) => ({ ...thread, lifecycle }))
    this.#updateSidebarThread(id, (thread) =>
      thread.lifecycle === lifecycle ? thread : { ...thread, lifecycle },
    )
    return lifecycle
  }

  wakeSnoozedThread(id: string, dueAt: number, at = Date.now()): ThreadLifecycle | undefined {
    const row = sqliteRow<ActiveLifecycleRow>(this.#wakeSnoozedThreadStatement, at, at, id, dueAt)
    if (!row) return undefined
    const lifecycle = toActiveLifecycle(row)
    this.#updateCachedThread(id, (thread) => ({ ...thread, lifecycle, lastActiveAt: at }))
    this.#updateSidebarThread(id, (thread) => ({ ...thread, lifecycle }))
    return lifecycle
  }

  setThreadKeepActive(id: string, keepActive: boolean, at = Date.now()): ThreadLifecycle {
    const lifecycle = this.activateThread(id, at)
    this.#db.prepare(`UPDATE threads SET keep_active = ? WHERE id = ?`).run(keepActive ? 1 : 0, id)
    const wokeAt = lifecycle.state === 'active' ? lifecycle.wokeAt : undefined
    const updated = activeLifecycle(keepActive, wokeAt)
    this.#updateCachedThread(id, (thread) => ({ ...thread, lifecycle: updated }))
    this.#updateSidebarThread(id, (thread) =>
      thread.lifecycle === updated ? thread : { ...thread, lifecycle: updated },
    )
    return updated
  }

  touchThread(id: string, unread = false, at = Date.now()): ThreadLifecycle {
    const retained = this.thread(id)
    if (retained === undefined) throw new Error('thread not found')
    // A closed thread is frozen history. An event still landing after close
    // must not resurrect it, and must not fail the dispatch that already
    // appended the event either.
    if (retained.closedAt !== undefined) return retained.lifecycle
    let lifecycle: ThreadLifecycle
    if (retained.lifecycle.state === 'active') {
      const result = this.#touchActiveThreadStatement.run(at, unread ? 1 : 0, id)
      if (Number(result.changes) === 0) throw new Error('thread not found')
      lifecycle = retained.lifecycle
    } else {
      const row = sqliteRow<ActiveLifecycleRow>(
        this.#touchThreadStatement,
        at,
        at,
        unread ? 1 : 0,
        id,
      )
      if (!row) throw new Error('thread not found')
      lifecycle = toActiveLifecycle(row)
    }
    this.#updateCachedThread(id, (thread) => ({
      ...thread,
      lifecycle,
      unread: thread.unread || unread,
      lastActiveAt: at,
    }))
    this.#updateSidebarThread(id, (thread) => {
      const nextUnread = thread.unread || unread
      return thread.lifecycle === lifecycle && thread.unread === nextUnread
        ? thread
        : { ...thread, lifecycle, unread: nextUnread }
    })
    return lifecycle
  }

  markThreadRead(id: string): void {
    const result = this.#db
      .prepare(`UPDATE threads SET unread = 0, woke_at = NULL WHERE id = ? AND closed_at IS NULL`)
      .run(id)
    if (result.changes === 0) {
      // Closed history is read-only; a missing id is still a caller error.
      if (this.thread(id) === undefined) throw new Error('thread not found')
      return
    }
    this.#updateCachedThread(id, (thread) => ({
      ...thread,
      lifecycle:
        thread.lifecycle.state === 'active'
          ? activeLifecycle(thread.lifecycle.keepActive, undefined)
          : thread.lifecycle,
      unread: false,
    }))
    this.#updateSidebarThread(id, (thread) => {
      const lifecycle =
        thread.lifecycle.state === 'active'
          ? activeLifecycle(thread.lifecycle.keepActive, undefined)
          : thread.lifecycle
      return thread.lifecycle === lifecycle && !thread.unread
        ? thread
        : { ...thread, lifecycle, unread: false }
    })
  }

  dueSnoozedThreadIds(now = Date.now()): string[] {
    return sqliteRows<ThreadIdRow>(this.#dueSnoozedThreadIds, now).map((row) => row.id)
  }

  inactiveThreadCandidates(cutoff: number): Array<{ id: string; unread: boolean }> {
    return sqliteRows<InactiveThreadCandidateRow>(this.#inactiveThreadCandidates, cutoff).map(
      (row) => ({ id: row.id, unread: row.unread === 1 }),
    )
  }

  /** The next time a lifecycle refresh can change persisted state. */
  nextLifecycleRefreshAt(): number | undefined {
    const snoozed = sqliteRow<MinTimestampRow>(this.#nextSnoozedThread)?.at
    const autoSettleDays = this.sidebarSettings().autoSettleDays
    const oldestActive =
      autoSettleDays === null ? null : sqliteRow<MinTimestampRow>(this.#oldestActiveThread)?.at
    const settleAt =
      autoSettleDays === null || oldestActive === null || oldestActive === undefined
        ? undefined
        : Number(oldestActive) + autoSettleDays * 24 * 60 * 60 * 1_000
    if (snoozed === null || snoozed === undefined) return settleAt
    return settleAt === undefined ? Number(snoozed) : Math.min(Number(snoozed), settleAt)
  }

  sidebarSettings(): SidebarSettings {
    if (this.#sidebarSettingsCache) return this.#sidebarSettingsCache
    const row = requiredSqliteRow<SidebarSettingsRow>(this.#readSidebarSettings)
    const parsed = SidebarSettingsSchema.safeParse({
      mode: row.mode,
      autoSettleDays: row.auto_settle_days === null ? null : Number(row.auto_settle_days),
    })
    // The lifecycle scheduler reads this at startup; a row a newer build
    // shaped differently must degrade, not keep the store from opening.
    this.#sidebarSettingsCache = Object.freeze(
      parsed.success ? parsed.data : { mode: 'classic', autoSettleDays: 3 },
    )
    if (!parsed.success) {
      console.warn('[store] unreadable sidebar settings, using defaults')
    }
    return this.#sidebarSettingsCache
  }

  updateSidebarSettings(settings: Partial<SidebarSettings>): SidebarSettings {
    const current = this.sidebarSettings()
    const next = Object.freeze({ ...current, ...settings })
    this.#writeSidebarSettings.run(next.mode, next.autoSettleDays)
    this.#sidebarSettingsCache = next
    return this.#sidebarSettingsCache
  }

  threadApproval(threadId: string): ApprovalMode | undefined {
    const row = this.#db
      .prepare('SELECT mode FROM thread_approvals WHERE thread_id = ?')
      .get(threadId)
    return ApprovalModeSchema.safeParse(row?.['mode']).data
  }

  setThreadApproval(threadId: string, mode: ApprovalMode): void {
    this.#db
      .prepare(
        `INSERT INTO thread_approvals (thread_id, mode) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET mode = excluded.mode`,
      )
      .run(threadId, mode)
  }

  backgroundModelPreference(): BackgroundModelPreference {
    if (this.#backgroundModelPreferenceCache) return this.#backgroundModelPreferenceCache
    const row = sqliteRow<StringValueRow>(this.#readAppSetting, BACKGROUND_MODEL_SETTING)
    if (!row) {
      this.#backgroundModelPreferenceCache = AUTOMATIC_BACKGROUND_MODEL_PREFERENCE
      return this.#backgroundModelPreferenceCache
    }
    try {
      this.#backgroundModelPreferenceCache = freezeBackgroundModelPreference(
        BackgroundModelPreferenceSchema.parse(JSON.parse(row.value)),
      )
    } catch {
      // Same shared-table story as the event log: a value a newer build
      // shaped differently degrades to the default, it does not brick reads.
      console.warn('[store] unreadable background model preference, using the default')
      this.#backgroundModelPreferenceCache = AUTOMATIC_BACKGROUND_MODEL_PREFERENCE
    }
    return this.#backgroundModelPreferenceCache
  }

  updateBackgroundModelPreference(
    preference: BackgroundModelPreference,
  ): BackgroundModelPreference {
    this.#writeAppSetting.run(BACKGROUND_MODEL_SETTING, JSON.stringify(preference))
    this.#backgroundModelPreferenceCache = freezeBackgroundModelPreference(preference)
    return this.#backgroundModelPreferenceCache
  }

  #updateThread(
    id: string,
    sql: string,
    update: (thread: StoredThread) => StoredThread,
    ...params: Array<string | number>
  ): void {
    const result = this.#db.prepare(sql).run(...params, id)
    if (result.changes === 0) throw new Error('thread not found')
    this.#updateCachedThread(id, update)
  }

  #cacheThread(id: string, thread: StoredThread | undefined): void {
    if (!this.#threadCache.has(id) && this.#threadCache.size >= THREAD_CACHE_LIMIT) {
      const oldestId = this.#threadCache.keys().next().value
      if (oldestId !== undefined) this.#threadCache.delete(oldestId)
    }
    this.#threadCache.set(id, thread ?? null)
  }

  #updateCachedThread(id: string, update: (thread: StoredThread) => StoredThread): void {
    const current = this.#threadCache.get(id)
    if (current === undefined) return
    if (current === null) {
      // A successful mutation proves that a previously missing row now exists.
      this.#threadCache.delete(id)
      return
    }
    const next = update(current)
    if (next !== current) this.#threadCache.set(id, next)
  }

  #invalidateSidebarThreads(): void {
    this.#pendingSidebarThreads = undefined
    this.#sidebarThreadsCache = undefined
    this.#sidebarThreadIndexes = undefined
  }

  #flushPendingSidebarThreads(): void {
    if (!this.#pendingSidebarThreads) return
    this.#sidebarThreadsCache = this.#pendingSidebarThreads
    this.#pendingSidebarThreads = undefined
  }

  #updateSidebarThread(id: string, update: SidebarThreadUpdate): void {
    const threads = this.#sidebarThreadsCache
    const index = this.#sidebarThreadIndexes?.get(id)
    if (!threads || index === undefined) return
    const current = (this.#pendingSidebarThreads ?? threads)[index]
    if (!current) {
      this.#invalidateSidebarThreads()
      return
    }
    const next = update(current)
    if (next === current) return
    const updated = this.#pendingSidebarThreads ?? [...threads]
    updated[index] = next
    this.#pendingSidebarThreads = updated
  }

  /**
   * Marks a session finished without discarding it. Closing a session ends the
   * process; it does not mean the user wanted the transcript gone.
   */
  closeThread(id: string): void {
    const closedAt = Date.now()
    this.#transaction(() => {
      this.#clearQueuedTurns(id)
      this.#db.prepare(`UPDATE threads SET closed_at = ? WHERE id = ?`).run(closedAt, id)
    })
    this.#updateCachedThread(id, (thread) => ({ ...thread, closedAt }))
    this.#updateSidebarThread(id, (thread) => ({ ...thread, closedAt }))
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
      this.#searchRevision += 1
      this.#ephemeralThreads.delete(id)
      this.#deleteCachedReplaySnapshot(id)
      this.#cacheThread(id, undefined)
      this.#invalidateSidebarThreads()
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  historyStorage() {
    const count = (sql: string) => Number((this.#db.prepare(sql).get() as { count: number }).count)
    const size = (file: string) =>
      file !== ':memory:' && existsSync(file) ? statSync(file).size : 0
    return {
      databaseBytes: size(this.location),
      walBytes: size(`${this.location}-wal`),
      reclaimableBytes:
        count('SELECT freelist_count AS count FROM pragma_freelist_count') *
        count('SELECT page_size AS count FROM pragma_page_size'),
      threads: count('SELECT count(*) AS count FROM threads'),
      closedThreads: count('SELECT count(*) AS count FROM threads WHERE closed_at IS NOT NULL'),
      events: count('SELECT count(*) AS count FROM events'),
    }
  }

  exportHistory(destination: string): void {
    this.#transaction(() => this.#writeHistoryArchive(destination))
  }

  /** No automatic retention: preview the exact eligible closed tasks before applying. */
  historyCleanupCandidates(before: number): string[] {
    if (!Number.isFinite(before) || before <= 0) throw new Error('cleanup requires a valid date')
    return sqliteRows<{ id: string }>(
      this.#db.prepare(
        'SELECT id FROM threads WHERE closed_at < ? AND worktree_path IS NULL ORDER BY closed_at, id',
      ),
      before,
    ).map((row) => row.id)
  }

  pruneHistory(before: number, archive: string): number {
    let ids: string[] = []
    this.#transaction(() => {
      ids = this.historyCleanupCandidates(before)
      // The archive is flushed to disk while the transaction still holds the
      // selected state. A failed write cannot erase even one conversation.
      this.#writeHistoryArchive(archive, ids)
      for (const id of ids) {
        this.#db.prepare('DELETE FROM session_search WHERE thread_id = ?').run(id)
        for (const table of [
          'events',
          'checkpoints',
          'restore_undos',
          'diff_decisions',
          'design_runs',
        ]) {
          this.#db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(id)
        }
        this.#db.prepare('DELETE FROM threads WHERE id = ?').run(id)
      }
    })
    for (const id of ids) {
      this.#ephemeralThreads.delete(id)
      this.#deleteCachedReplaySnapshot(id)
      this.#cacheThread(id, undefined)
    }
    this.#searchRevision += 1
    this.#searchSnapshots.clear()
    this.#queuedThreadIdsCache = undefined
    this.#invalidateSidebarThreads()
    return ids.length
  }

  reclaimHistorySpace(): void {
    // Explicit maintenance only; VACUUM is never on the streaming path.
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.#db.exec('VACUUM')
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  #writeHistoryArchive(destination: string, ids?: readonly string[]): void {
    const descriptor = openSync(destination, 'wx', 0o600)
    let complete = false
    try {
      const write = (value: unknown) => {
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
        let offset = 0
        while (offset < bytes.length)
          offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      }
      write({
        format: 'tastecode-history',
        version: 1,
        exportedAt: Date.now(),
        checkpointNamespace: this.checkpointNamespace,
      })
      const tables = [
        'threads',
        'events',
        'checkpoints',
        'restore_undos',
        'diff_decisions',
        'design_runs',
      ] as const
      for (const table of tables) {
        const key = table === 'threads' ? 'id' : 'thread_id'
        if (ids) {
          const query = this.#db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`)
          for (const id of ids) for (const row of query.iterate(id)) write({ table, row })
        } else {
          for (const row of this.#db.prepare(`SELECT * FROM ${table}`).iterate())
            write({ table, row })
        }
      }
      fsyncSync(descriptor)
      complete = true
    } finally {
      closeSync(descriptor)
      if (!complete) rmSync(destination, { force: true })
    }
  }

  setDesignRun(threadId: string, payload: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO design_runs (thread_id, payload) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(threadId, serializeJson(payload))
  }

  designRun(threadId: string): JsonValue | undefined {
    const row = sqliteRow<PayloadRow>(
      this.#db.prepare(`SELECT payload FROM design_runs WHERE thread_id = ?`),
      threadId,
    )
    if (!row) return undefined
    return parseJsonValue(row.payload)
  }

  deleteDesignRun(threadId: string): void {
    this.#db.prepare(`DELETE FROM design_runs WHERE thread_id = ?`).run(threadId)
  }

  // ---- queued turns -----------------------------------------------------

  queuedTurns(threadId: string): StoredQueuedTurn[] {
    const turns: StoredQueuedTurn[] = []
    for (const row of sqliteRows<QueuedTurnRow>(this.#listQueuedTurns, threadId)) {
      const turn = toQueuedTurn(row)
      if (turn !== undefined) turns.push(turn)
    }
    return turns
  }

  queuedThreadIds(): Set<string> {
    this.#queuedThreadIdsCache ??= new Set(
      sqliteRows<{ thread_id: string }>(this.#queuedThreadIds).map((row) => row.thread_id),
    )
    return this.#queuedThreadIdsCache
  }

  hasQueuedSubmission(threadId: string, clientSubmissionId: string): boolean {
    return this.#hasQueuedSubmission.get(threadId, clientSubmissionId) !== undefined
  }

  enqueueQueuedTurn(turn: Omit<StoredQueuedTurn, 'intent'>): void {
    const payload = JSON.stringify({
      text: turn.text,
      attachments: turn.attachments,
      options: turn.options,
    })
    this.#transaction(() => {
      const open = this.#openThread.get(turn.threadId)
      if (!open) throw new Error('thread not found')
      const position = Number(
        requiredSqliteRow<PositionRow>(this.#nextQueuedPosition, turn.threadId).position,
      )
      this.#appendQueuedTurnEvent(turn.threadId, turn.id, 'enqueue', {
        ...turn,
        intent: 'normal',
        position,
      })
      this.#insertQueuedTurn.run(
        turn.threadId,
        turn.id,
        turn.clientSubmissionId ?? null,
        position,
        payload,
        turn.createdAt,
      )
    })
    this.#queuedThreadIdsCache = undefined
  }

  deleteQueuedTurn(threadId: string, queueId: string): boolean {
    return this.#mutateQueuedTurn(threadId, queueId, 'queued', 'delete', () => {
      this.#deleteQueuedTurn.run(threadId, queueId)
    })
  }

  moveQueuedTurn(threadId: string, queueId: string, direction: 'up' | 'down'): boolean {
    return this.#transaction(() => {
      const current = sqliteRow<PositionRow>(this.#queuedTurnPosition, threadId, queueId)
      if (!current) return false
      const adjacent = sqliteRow<AdjacentQueuedTurnRow>(
        direction === 'up' ? this.#previousQueuedTurn : this.#nextQueuedTurn,
        threadId,
        current.position,
      )
      if (!adjacent) return false
      this.#appendQueuedTurnEvent(threadId, queueId, 'move', { direction })
      this.#swapQueuedTurnPositions.run(
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
    const claimed = this.#transaction(() => {
      const row = sqliteRow<QueuedTurnRow>(this.#findQueuedTurn, threadId, queueId)
      if (!row) return undefined
      const stored = toQueuedTurn(row)
      // Cannot honestly dispatch a prompt this build cannot read; the row
      // stays queued for a build that can.
      if (stored === undefined) return undefined
      this.#appendQueuedTurnEvent(threadId, queueId, 'claim', { intent })
      this.#dispatchQueuedTurn.run(intent, threadId, queueId)
      return { ...stored, intent }
    })
    if (claimed) this.#queuedThreadIdsCache = undefined
    return claimed
  }

  restoreQueuedTurn(threadId: string, queueId: string): boolean {
    return this.#mutateQueuedTurn(threadId, queueId, 'dispatching', 'restore', () => {
      this.#restoreQueuedTurn.run(threadId, queueId)
    })
  }

  completeQueuedTurn(threadId: string, queueId: string): boolean {
    return this.#mutateQueuedTurn(threadId, queueId, 'dispatching', 'complete', () => {
      this.#deleteQueuedTurn.run(threadId, queueId)
    })
  }

  appendAndCompleteQueuedTurn(
    threadId: string,
    queueId: string,
    event: DomainEvent,
  ): SerializedEventAppend {
    const serializedEvent = JSON.stringify(event)
    const seq = this.#transaction(() => {
      const claimed = this.#claimedQueuedTurn.get(threadId, queueId)
      if (!claimed) throw new Error('queued prompt is no longer claimed')
      const eventSeq = this.#appendEventPayload(threadId, event, Date.now(), serializedEvent)
      this.#appendQueuedTurnEvent(threadId, queueId, 'complete', {})
      this.#deleteClaimedQueuedTurn.run(threadId, queueId)
      return eventSeq
    })
    return { seq, serializedEvent }
  }

  clearQueuedTurns(threadId: string): void {
    this.#transaction(() => this.#clearQueuedTurns(threadId))
  }

  clearAllQueuedTurns(): string[] {
    const threadIds = this.#transaction(() => {
      const threadIds = sqliteRows<{ thread_id: string }>(
        this.#db.prepare(`SELECT DISTINCT thread_id FROM queued_turns ORDER BY thread_id`),
      ).map((row) => row.thread_id)
      for (const threadId of threadIds) this.#clearQueuedTurns(threadId)
      return threadIds
    })
    if (threadIds.length > 0) this.#queuedThreadIdsCache = undefined
    return threadIds
  }

  #mutateQueuedTurn(
    threadId: string,
    queueId: string,
    state: 'queued' | 'dispatching',
    mutation: string,
    project: () => void,
  ): boolean {
    const changed = this.#transaction(() => {
      const exists = this.#queuedTurnInState.get(threadId, queueId, state)
      if (!exists) return false
      this.#appendQueuedTurnEvent(threadId, queueId, mutation, {})
      project()
      return true
    })
    if (changed) this.#queuedThreadIdsCache = undefined
    return changed
  }

  #clearQueuedTurns(threadId: string): void {
    const exists = this.#hasQueuedTurn.get(threadId)
    if (!exists) return
    this.#appendQueuedTurnEvent(threadId, null, 'clear', {})
    this.#clearQueuedTurnsStatement.run(threadId)
    this.#queuedThreadIdsCache = undefined
  }

  #appendQueuedTurnEvent(
    threadId: string,
    queueId: string | null,
    mutation: string,
    payload: unknown,
  ): void {
    this.#insertQueuedTurnEvent.run(threadId, queueId, Date.now(), mutation, serializeJson(payload))
  }

  #recoverQueuedTurnClaims(): void {
    const claims = sqliteRows<QueuedTurnClaimRow>(
      this.#db.prepare(
        `SELECT thread_id, queue_id, intent FROM queued_turns WHERE state = 'dispatching'`,
      ),
    ).map((claim) => ({ ...claim, intent: queuedTurnIntent(claim.intent) }))
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

  setDiffDecision(threadId: string, targetId: string, decision: DiffDecision): void {
    this.#db
      .prepare(
        `INSERT INTO diff_decisions (thread_id, target_id, decision) VALUES (?, ?, ?)
         ON CONFLICT (thread_id, target_id) DO UPDATE SET decision = excluded.decision`,
      )
      .run(threadId, targetId, decision)
  }

  diffDecision(threadId: string, targetId: string): DiffDecision | undefined {
    const row = sqliteRow<DiffDecisionRow>(
      this.#db.prepare(`SELECT decision FROM diff_decisions WHERE thread_id = ? AND target_id = ?`),
      threadId,
      targetId,
    )
    if (!row) return undefined
    const parsed = DiffDecisionSchema.safeParse(row.decision)
    if (parsed.success) return parsed.data
    console.warn(`[store] unknown diff decision '${row.decision}', treating as undecided`)
    return undefined
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
      // The write path keeps only current process-owned lifecycles here. A
      // long transcript therefore costs the same to recover as a short one.
      const rows = sqliteRows<InterruptedThreadRow>(this.#readInterruptedThreads)

      const states = new Map<string, InterruptedThreadState>()
      for (const row of rows) {
        // Leave newer-provider histories intact; they must not abort recovery of other threads.
        if (!this.thread(row.thread_id)) continue
        const event = parseDomainEvent(
          row.payload,
          `recovery for interrupted thread ${row.thread_id}`,
        )
        if (event === undefined) continue
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
      // The append/touch calls above also wrote to in-memory caches and the
      // search revision; a database rollback does not undo those.
      this.#threadCache.clear()
      this.#invalidateSidebarThreads()
      this.#searchRevision += 1
      throw error
    }
  }

  /** Returns the sequence number, which is what a client resumes from. */
  append(threadId: string, event: DomainEvent): number {
    const at = Date.now()
    const serializedEvent = JSON.stringify(event)
    return this.#appendSerializedEvent(threadId, event, at, serializedEvent)
  }

  /** Return the exact stored JSON so the push path can reuse its encoding. */
  appendWithSerializedEvent(threadId: string, event: DomainEvent): SerializedEventAppend {
    const at = Date.now()
    const serializedEvent = JSON.stringify(event)
    return {
      seq: this.#appendSerializedEvent(threadId, event, at, serializedEvent),
      serializedEvent,
    }
  }

  #appendSerializedEvent(
    threadId: string,
    event: DomainEvent,
    at: number,
    serializedEvent: string,
  ): number {
    // Token deltas intentionally have no secondary index. Keep the dominant
    // write path to one serialization and one prepared SQLite insert.
    if (event.type === 'item.delta') {
      return this.#insertEventRow(threadId, at, serializedEvent)
    }
    const searchEntry = this.#ephemeralThreads.has(threadId) ? undefined : searchableEntry(event)
    const usageEvent = event.type === 'usage.updated'
    const inboxEvent = affectsInboxProjection(event)
    const userSubmissionId = userSubmissionItemId(event)
    const turnDiffId = event.type === 'diff.updated' ? event.turnId : undefined
    const recovery = recoveryMutation(event)
    // A lone SQLite insert is already atomic. Only open an explicit
    // transaction when the event and a derived index row must commit together.
    if (
      !searchEntry &&
      !usageEvent &&
      !inboxEvent &&
      userSubmissionId === undefined &&
      turnDiffId === undefined &&
      recovery === undefined
    ) {
      return this.#insertEventRow(threadId, at, serializedEvent)
    }

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const seq = this.#insertEventRow(threadId, at, serializedEvent)
      if (searchEntry) this.#indexSearchEntry(seq, threadId, at, searchEntry)
      if (usageEvent) this.#indexUsageEvent(seq, threadId, at, serializedEvent)
      if (inboxEvent) this.#indexInboxEvent(seq, threadId, event, serializedEvent)
      if (userSubmissionId) this.#indexUserSubmission(seq, threadId, userSubmissionId)
      if (turnDiffId !== undefined) this.#indexTurnDiff(seq, threadId, turnDiffId)
      if (recovery) this.#indexRecoveryMutation(seq, threadId, recovery, serializedEvent)
      this.#db.exec('COMMIT')
      return seq
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Persist one window and retain each exact event encoding for its push. */
  appendBatchWithSerializedEvents(
    records: ReadonlyArray<{ threadId: string; event: DomainEvent }>,
  ): SerializedEventAppend[] {
    if (records.length === 0) return []
    const at = Date.now()
    return this.#transaction(() =>
      records.map(({ threadId, event }) => {
        const serializedEvent = JSON.stringify(event)
        return {
          seq: this.#appendEventPayload(threadId, event, at, serializedEvent),
          serializedEvent,
        }
      }),
    )
  }

  hasUserSubmission(threadId: string, itemId: string): boolean {
    return this.#hasUserSubmission.get(threadId, itemId) !== undefined
  }

  #insertEventRow(threadId: string, at: number, payload: string): number {
    if (this.#replaySnapshotCache.size > 0) this.#deleteCachedReplaySnapshot(threadId)
    return Number(this.#insertEvent.run(threadId, at, payload).lastInsertRowid)
  }

  #appendEvent(threadId: string, event: DomainEvent, at: number): number {
    return this.#appendEventPayload(threadId, event, at, JSON.stringify(event))
  }

  #appendEventPayload(threadId: string, event: DomainEvent, at: number, payload: string): number {
    const seq = this.#insertEventRow(threadId, at, payload)
    if (event.type === 'item.delta') return seq
    if (!this.#ephemeralThreads.has(threadId)) this.#indexEvent(seq, threadId, at, event)
    if (event.type === 'usage.updated') this.#indexUsageEvent(seq, threadId, at, payload)
    if (affectsInboxProjection(event)) this.#indexInboxEvent(seq, threadId, event, payload)
    const userSubmissionId = userSubmissionItemId(event)
    if (userSubmissionId) this.#indexUserSubmission(seq, threadId, userSubmissionId)
    if (event.type === 'diff.updated') this.#indexTurnDiff(seq, threadId, event.turnId)
    const recovery = recoveryMutation(event)
    if (recovery) this.#indexRecoveryMutation(seq, threadId, recovery, payload)
    return seq
  }

  /**
   * The thread's history, optionally only what happened after `afterSeq`.
   *
   * A client that was connected and fell behind asks for the tail; one opening
   * the thread fresh asks for all of it. Same call either way.
   */
  history(threadId: string, afterSeq = 0): Array<{ seq: number; event: DomainEvent }> {
    const entries: Array<{ seq: number; event: DomainEvent }> = []
    for (const row of sqliteRows<HistoryRow>(this.#threadHistory, threadId, afterSeq)) {
      const event = parseDomainEvent(row.payload, `history for thread ${threadId}`)
      if (event === undefined) continue
      entries.push({ seq: Number(row.seq), event })
    }
    return entries
  }

  /** Read the latest saved replay as an immutable base, even when a small tail is newer. */
  replaySnapshotBase(threadId: string): { seq: number; entries: ReplayEntry[] } | undefined {
    const cached = this.#replaySnapshotCache.get(threadId)
    if (cached) {
      this.#promoteCachedReplaySnapshot(threadId, cached)
      return { seq: cached.seq, entries: cached.entries }
    }
    const row = sqliteRow<ReplaySnapshotRow>(this.#readReplaySnapshotBase, threadId)
    if (!row) return undefined
    const seq = Number(row.seq)
    const entries = this.#cacheReplaySnapshot(threadId, seq, row.payload)
    return entries ? { seq, entries } : undefined
  }

  /** Preserve SQLite's JSON for the first response after a process restart. */
  tailReplaySnapshotForResponse(
    threadId: string,
  ): { entries: ReplayEntry[]; serializedEntries?: string | undefined } | undefined {
    const cached = this.#replaySnapshotCache.get(threadId)
    if (cached) {
      this.#promoteCachedReplaySnapshot(threadId, cached)
      return { entries: cached.entries }
    }
    const row = sqliteRow<ReplaySnapshotRow>(this.#readTailReplaySnapshot, threadId)
    if (!row) return undefined
    const entries = this.#cacheReplaySnapshot(threadId, Number(row.seq), row.payload)
    return entries ? { entries, serializedEntries: row.payload } : undefined
  }

  #cacheReplaySnapshot(threadId: string, seq: number, payload: string): ReplayEntry[] | undefined {
    try {
      const entries = ReplaySnapshotSchema.parse(JSON.parse(payload))
      this.#rememberReplaySnapshot(threadId, seq, entries, payload.length)
      return entries
    } catch {
      this.#deleteReplaySnapshot.run(threadId)
      this.#deleteCachedReplaySnapshot(threadId)
      return undefined
    }
  }

  #promoteCachedReplaySnapshot(
    threadId: string,
    cached: { seq: number; entries: ReplayEntry[]; characters: number },
  ): void {
    this.#replaySnapshotCache.delete(threadId)
    this.#replaySnapshotCache.set(threadId, cached)
  }

  #rememberReplaySnapshot(
    threadId: string,
    seq: number,
    entries: ReplayEntry[],
    characters: number,
  ): void {
    this.#deleteCachedReplaySnapshot(threadId)
    if (characters > REPLAY_SNAPSHOT_CACHE_CHARACTER_LIMIT) return
    while (
      this.#replaySnapshotCache.size >= REPLAY_SNAPSHOT_CACHE_LIMIT ||
      this.#replaySnapshotCacheCharacters + characters > REPLAY_SNAPSHOT_CACHE_CHARACTER_LIMIT
    ) {
      const oldestThreadId = this.#replaySnapshotCache.keys().next().value
      if (oldestThreadId === undefined) break
      this.#deleteCachedReplaySnapshot(oldestThreadId)
    }
    this.#replaySnapshotCache.set(threadId, { seq, entries, characters })
    this.#replaySnapshotCacheCharacters += characters
  }

  #deleteCachedReplaySnapshot(threadId: string): void {
    const cached = this.#replaySnapshotCache.get(threadId)
    if (!cached) return
    this.#replaySnapshotCache.delete(threadId)
    this.#replaySnapshotCacheCharacters -= cached.characters
  }

  /** Cache only renderer-ready derived data; the event log remains authoritative. */
  saveReplaySnapshot(
    threadId: string,
    seq: number,
    entries: ReadonlyArray<{ seq: number; event: DomainEvent }>,
  ): string {
    const payload = JSON.stringify(entries)
    this.#writeReplaySnapshot.run(threadId, seq, payload)
    this.#rememberReplaySnapshot(threadId, seq, entries as ReplayEntry[], payload.length)
    return payload
  }

  /** Build only non-default sidebar status rows in one database read. */
  inboxProjections(): Map<string, InboxProjection> {
    const projections = new Map<string, InboxProjection>()
    for (const row of sqliteRows<ThreadEventRow>(this.#threadInboxEvents)) {
      const event = parseDomainEvent(row.payload, `inbox projections for thread ${row.thread_id}`)
      if (event === undefined) continue
      const projection = projections.get(row.thread_id) ?? emptyInboxProjection()
      applyInboxProjectionEvent(projection, event)
      if (isEmptyInboxProjection(projection)) projections.delete(row.thread_id)
      else projections.set(row.thread_id, projection)
    }
    return projections
  }

  /** The final provider-owned patch shown for one turn. */
  turnDiff(threadId: string, turnId: string): string | undefined {
    const row = sqliteRow<PayloadRow>(this.#readTurnDiff, threadId, turnId)
    if (!row) return undefined
    const event = parseDomainEvent(row.payload, `turn diff for thread ${threadId}`)
    return event?.type === 'diff.updated' ? event.diff : undefined
  }

  searchSessions(options: SessionSearchOptions): SessionSearchPage {
    const requestedLimit = options.limit ?? 25
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_PAGE_SIZE)
      : 25
    const terms = searchTerms(options.query)
    if (terms.length === 0) return { results: [], nextCursor: null }
    const ftsQuery = toFtsQuery(terms)
    const cursor = decodeCursor(options.cursor)
    const parameters: Array<string | number> = [ftsQuery]
    let filterMask = 0

    if (options.projectPath) {
      filterMask |= 1
      parameters.push(options.projectPath)
    }
    if (options.provider) {
      filterMask |= 2
      parameters.push(options.provider)
    }

    const now = Date.now()
    this.#pruneSearchSnapshots(now, false)
    let snapshotId: string
    let snapshot: SearchSnapshot
    if (cursor) {
      snapshotId = cursor.snapshotId
      const retained = this.#searchSnapshots.get(snapshotId)
      if (!retained || retained.expiresAt <= now) {
        this.#searchSnapshots.delete(snapshotId)
        throw new Error('Search results expired. Search again.')
      }
      if (
        retained.ftsQuery !== ftsQuery ||
        retained.projectPath !== (options.projectPath ?? null) ||
        retained.provider !== (options.provider ?? null)
      ) {
        throw new Error('Search cursor does not match this query.')
      }
      retained.expiresAt = now + SEARCH_SNAPSHOT_TTL_MS
      this.#searchSnapshots.delete(snapshotId)
      this.#searchSnapshots.set(snapshotId, retained)
      snapshot = retained
    } else {
      const projectPath = options.projectPath ?? null
      const provider = options.provider ?? null
      let cached: [string, SearchSnapshot] | undefined
      for (const entry of this.#searchSnapshots) {
        const retained = entry[1]
        if (
          retained.revision === this.#searchRevision &&
          retained.ftsQuery === ftsQuery &&
          retained.projectPath === projectPath &&
          retained.provider === provider
        ) {
          cached = entry
          break
        }
      }
      if (cached) {
        snapshotId = cached[0]
        snapshot = cached[1]
        snapshot.expiresAt = now + SEARCH_SNAPSHOT_TTL_MS
        this.#searchSnapshots.delete(snapshotId)
        this.#searchSnapshots.set(snapshotId, snapshot)
      } else {
        this.#pruneSearchSnapshots(now, true)
        const selectSnapshot = this.#selectSearchSnapshot.get(filterMask)
        if (!selectSnapshot) throw new Error('search filter statement is unavailable')
        const row = sqliteRow<SearchRowIdsRow>(selectSnapshot, ...parameters)
        snapshotId = randomUUID()
        snapshot = {
          ftsQuery,
          terms,
          projectPath,
          provider,
          revision: this.#searchRevision,
          expiresAt: now + SEARCH_SNAPSHOT_TTL_MS,
          rowIds: parseSearchRowIds(row?.search_rowids ?? '[]'),
        }
        this.#searchSnapshots.set(snapshotId, snapshot)
      }
    }

    const position = cursor?.position ?? 0
    const pageRowIds = searchRowIdPage(snapshot.rowIds, position, position + limit + 1)
    const rows = sqliteRows<SearchResultRow>(
      this.#readSearchResults,
      position,
      JSON.stringify(pageRowIds),
    )

    const page = rows.slice(0, limit)
    const comparableTerms = terms.map(comparableSearchToken)
    const resultIds = encodeSearchResultIds(
      this.#searchResultKey,
      page.map((row) => Number(row.event_seq)),
    )
    const last = page.at(-1)
    const hasMore = rows.length > limit && last !== undefined
    const results: SessionSearchResult[] = []
    for (const [index, row] of page.entries()) {
      const provider = toProviderId(row.provider)
      if (provider === undefined) continue
      results.push({
        resultId: resultIds[index]!,
        projectPath: row.project_path,
        projectName: row.project_name,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        turnId: row.turn_id,
        provider,
        createdAt: Number(row.created_at),
        snippet: createSearchSnippetWithComparableTerms(row.text, comparableTerms),
      })
    }
    return {
      results,
      nextCursor: hasMore
        ? encodeCursor({
            snapshotId,
            position: Number(last.position),
          })
        : null,
    }
  }

  #pruneSearchSnapshots(now: number, reserveSlot: boolean): void {
    for (const [snapshotId, snapshot] of this.#searchSnapshots) {
      if (snapshot.expiresAt <= now) this.#searchSnapshots.delete(snapshotId)
    }
    const retainedCount = MAX_SEARCH_SNAPSHOTS - (reserveSlot ? 1 : 0)
    while (this.#searchSnapshots.size > retainedCount) {
      const oldestSnapshotId = this.#searchSnapshots.keys().next().value
      if (oldestSnapshotId === undefined) break
      this.#searchSnapshots.delete(oldestSnapshotId)
    }
  }

  #indexEvent(seq: number, threadId: string, at: number, event: DomainEvent): void {
    const entry = searchableEntry(event)
    if (!entry) return
    this.#indexSearchEntry(seq, threadId, at, entry)
  }

  #indexSearchEntry(seq: number, threadId: string, at: number, entry: SearchableEntry): void {
    const previousRevision = this.#searchRevision
    this.#insertSearchEntry.run(seq, threadId, seq, entry.turnId, entry.createdAt ?? at, entry.text)
    this.#searchRevision = previousRevision + 1
    if (this.#searchSnapshots.size === 0) return
    const thread = this.#threadCache.get(threadId)
    let tokens: string[] | undefined
    let tokensComputed = false
    for (const snapshot of this.#searchSnapshots.values()) {
      if (snapshot.revision !== previousRevision) continue
      if (
        thread &&
        ((snapshot.projectPath !== null && snapshot.projectPath !== thread.projectPath) ||
          (snapshot.provider !== null && snapshot.provider !== thread.provider))
      ) {
        snapshot.revision = this.#searchRevision
        continue
      }
      if (!tokensComputed) {
        tokens = asciiFtsTextTokens(entry.text)
        tokensComputed = true
      }
      if (!tokens) continue
      if (asciiFtsTokensDefinitelyMiss(snapshot.terms, tokens)) {
        snapshot.revision = this.#searchRevision
      }
    }
  }

  #indexUsageEvent(seq: number, threadId: string, at: number, payload: string): void {
    this.#insertUsageEvent.run(seq, threadId, at, payload)
  }

  #indexInboxEvent(seq: number, threadId: string, event: DomainEvent, payload: string): void {
    if (event.type === 'approval.requested' || event.type === 'user_input.requested') {
      this.#deleteInboxRequest.run(threadId, event.type, event.request.id)
      this.#insertInboxEvent.run(seq, threadId, payload)
      return
    }
    if (event.type === 'approval.resolved') {
      this.#deleteInboxRequest.run(threadId, 'approval.requested', event.id)
      return
    }
    if (event.type === 'user_input.resolved') {
      this.#deleteInboxRequest.run(threadId, 'user_input.requested', event.id)
      return
    }
    if (event.type === 'thread.error') {
      this.#deleteInboxStatus.run(threadId)
      this.#insertInboxEvent.run(seq, threadId, payload)
      return
    }
    if (event.type === 'turn.completed') {
      this.#deleteInboxStatus.run(threadId)
      if (event.status === 'failed') this.#insertInboxEvent.run(seq, threadId, payload)
    }
  }

  #indexUserSubmission(seq: number, threadId: string, itemId: string): void {
    this.#insertUserSubmission.run(threadId, itemId, seq)
  }

  #indexTurnDiff(seq: number, threadId: string, turnId: string): void {
    this.#insertTurnDiffEvent.run(seq, threadId, turnId)
  }

  #indexRecoveryMutation(
    seq: number,
    threadId: string,
    mutation: RecoveryMutation,
    payload: string,
  ): void {
    if (mutation.kind === 'start') {
      this.#upsertRecoveryStart.run(
        threadId,
        mutation.lifecycleKey,
        mutation.eventType,
        seq,
        payload,
      )
      return
    }
    if (mutation.kind === 'terminal') {
      this.#settleRecoveryLifecycle.run(threadId, mutation.lifecycleKey, seq)
      return
    }
    this.#upsertRecoveryError.run(threadId, seq)
  }

  #rebuildDerivedIndexes(rebuild: DerivedIndexRebuild): void {
    const eventTypes = new Set<DomainEvent['type']>()
    const include = (...types: DomainEvent['type'][]) => {
      for (const type of types) eventTypes.add(type)
    }
    if (rebuild.search) include('item.completed')
    if (rebuild.usage) include('usage.updated')
    if (rebuild.inbox) {
      include(
        'approval.requested',
        'approval.resolved',
        'user_input.requested',
        'user_input.resolved',
        'thread.error',
        'turn.completed',
      )
    }
    if (rebuild.userSubmission) include('item.started', 'item.completed')
    if (rebuild.turnDiff) include('diff.updated')
    if (rebuild.recovery) {
      include(
        'turn.started',
        'turn.completed',
        'thread.error',
        'item.started',
        'item.completed',
        'approval.requested',
        'approval.resolved',
        'user_input.requested',
        'user_input.resolved',
        'approval.review.started',
        'approval.review.completed',
      )
    }

    const types = [...eventTypes]
    const placeholders = types.map(() => '?').join(', ')
    const batch = this.#db.prepare(
      `SELECT seq, thread_id, at, payload FROM events
       WHERE seq > ?
         AND json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.type') IN (${placeholders})
         AND seq NOT IN (SELECT event_seq FROM provider_history_events WHERE active = 0)
       ORDER BY seq LIMIT 5000`,
    )
    const saveMigration = this.#db.prepare(
      `INSERT OR REPLACE INTO schema_migrations (name) VALUES (?)`,
    )
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (rebuild.search) this.#db.exec(`DELETE FROM session_search`)
      if (rebuild.usage) this.#db.exec(`DELETE FROM usage_events`)
      if (rebuild.inbox) this.#db.exec(`DELETE FROM inbox_events`)
      if (rebuild.userSubmission) this.#db.exec(`DELETE FROM user_submission_items`)
      if (rebuild.turnDiff) this.#db.exec(`DELETE FROM turn_diff_events`)
      if (rebuild.recovery) {
        this.#db.exec(`DELETE FROM recovery_lifecycles; DELETE FROM recovery_errors`)
      }

      let cursor = 0
      for (;;) {
        const rows = sqliteRows<EventRow>(batch, cursor, ...types)
        if (rows.length === 0) break
        for (const row of rows) {
          const event = parseDomainEvent(
            row.payload,
            `derived index rebuild at event seq ${Number(row.seq)}`,
          )
          if (event === undefined) continue
          const seq = Number(row.seq)
          const at = Number(row.at)
          if (rebuild.search) this.#indexEvent(seq, row.thread_id, at, event)
          if (rebuild.usage && event.type === 'usage.updated') {
            this.#indexUsageEvent(seq, row.thread_id, at, row.payload)
          }
          if (rebuild.inbox && affectsInboxProjection(event)) {
            this.#indexInboxEvent(seq, row.thread_id, event, row.payload)
          }
          if (rebuild.userSubmission) {
            const itemId = userSubmissionItemId(event)
            if (itemId) this.#indexUserSubmission(seq, row.thread_id, itemId)
          }
          if (rebuild.turnDiff && event.type === 'diff.updated') {
            this.#indexTurnDiff(seq, row.thread_id, event.turnId)
          }
          if (rebuild.recovery) {
            const mutation = recoveryMutation(event)
            if (mutation) {
              this.#indexRecoveryMutation(seq, row.thread_id, mutation, row.payload)
            }
          }
        }
        cursor = Number(rows.at(-1)?.seq ?? cursor)
      }

      if (rebuild.search) saveMigration.run(SEARCH_INDEX_VERSION)
      if (rebuild.usage) saveMigration.run(USAGE_INDEX_VERSION)
      if (rebuild.inbox) saveMigration.run(INBOX_INDEX_VERSION)
      if (rebuild.userSubmission) saveMigration.run(USER_SUBMISSION_INDEX_VERSION)
      if (rebuild.turnDiff) saveMigration.run(TURN_DIFF_INDEX_VERSION)
      if (rebuild.recovery) saveMigration.run(RECOVERY_STATE_VERSION)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #rebuildThreadRecoveryState(threadId: string): void {
    this.#db.prepare(`DELETE FROM recovery_lifecycles WHERE thread_id = ?`).run(threadId)
    this.#db.prepare(`DELETE FROM recovery_errors WHERE thread_id = ?`).run(threadId)
    const rows = sqliteRows<EventRow>(
      this.#db.prepare(
        `SELECT seq, thread_id, at, payload
         FROM events
         WHERE thread_id = ?
           AND seq NOT IN (SELECT event_seq FROM provider_history_events WHERE active = 0)
           AND json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.type') IN (
             'turn.started', 'turn.completed', 'thread.error',
             'item.started', 'item.completed',
             'approval.requested', 'approval.resolved',
             'user_input.requested', 'user_input.resolved',
             'approval.review.started', 'approval.review.completed'
           )
         ORDER BY seq`,
      ),
      threadId,
    )
    for (const row of rows) {
      const event = parseDomainEvent(row.payload, `recovery index rebuild for thread ${threadId}`)
      if (event === undefined) continue
      const mutation = recoveryMutation(event)
      if (mutation) {
        this.#indexRecoveryMutation(Number(row.seq), row.thread_id, mutation, row.payload)
      }
    }
  }

  #rebuildThreadInboxState(threadId: string): void {
    this.#deleteThreadInboxEvents.run(threadId)
    const rows = sqliteRows<EventRow>(
      this.#db.prepare(
        `SELECT seq, thread_id, at, payload
         FROM events
         WHERE thread_id = ?
           AND seq NOT IN (SELECT event_seq FROM provider_history_events WHERE active = 0)
           AND json_extract(CASE WHEN json_valid(payload) THEN payload END, '$.type') IN (
             'approval.requested', 'approval.resolved',
             'user_input.requested', 'user_input.resolved',
             'thread.error', 'turn.completed'
           )
         ORDER BY seq`,
      ),
      threadId,
    )
    for (const row of rows) {
      const event = parseDomainEvent(row.payload, `inbox index rebuild for thread ${threadId}`)
      if (event === undefined) continue
      this.#indexInboxEvent(Number(row.seq), row.thread_id, event, row.payload)
    }
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
    const parseUsage = (payload: string, owner: string): UsageSample | undefined => {
      const event = parseDomainEvent(payload, `usage summary for thread ${owner}`)
      return event?.type === 'usage.updated'
        ? { total: withoutContext(event.usage), cumulative: event.usage.cumulative === true }
        : undefined
    }

    let session = emptyUsage()
    {
      const rows = sqliteRows<PayloadRow>(
        this.#db.prepare(
          `SELECT payload FROM usage_events
           WHERE thread_id = ? ORDER BY at, event_seq`,
        ),
        threadId,
      )
      let previous: UsageTotal | undefined
      for (const row of rows) {
        const sample = parseUsage(row.payload, threadId)
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
      const seeds = sqliteRows<ThreadPayloadRow>(
        this.#db.prepare(
          `SELECT thread_id, payload FROM (
             SELECT thread_id, payload,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY at DESC, event_seq DESC) AS position
             FROM usage_events WHERE at < ?
           ) WHERE position = 1`,
        ),
        since,
      )
      for (const seed of seeds) {
        const usage = parseUsage(seed.payload, seed.thread_id)
        if (usage?.cumulative) previous.set(seed.thread_id, usage.total)
      }

      const rows = sqliteRows<ThreadPayloadRow>(
        this.#db.prepare(
          `SELECT u.thread_id, u.payload, t.provider
           FROM usage_events u JOIN threads t ON t.id = u.thread_id
           WHERE u.at >= ?
           ORDER BY u.thread_id, u.at, u.event_seq`,
        ),
        since,
      )
      for (const row of rows) {
        const sample = parseUsage(row.payload, row.thread_id)
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

  recordCheckpointRepository(repoPath: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO checkpoint_repositories(path) VALUES (?)').run(repoPath)
  }

  checkpointRepositories(): string[] {
    return sqliteRows<{ path: string }>(
      this.#db.prepare('SELECT path FROM checkpoint_repositories'),
    ).map((row) => row.path)
  }

  /** Include the hidden conversation tail needed to undo a restore. */
  checkpointReferences(): Array<{
    threadId: string
    projectPath: string
    worktreePath?: string
    commits: Set<string>
  }> {
    const result = new Map<
      string,
      { threadId: string; projectPath: string; worktreePath?: string; commits: Set<string> }
    >()
    const add = (threadId: string, commit: string) => {
      const thread = this.thread(threadId)
      if (!thread) return
      let entry = result.get(threadId)
      if (!entry) {
        entry = {
          threadId,
          projectPath: thread.projectPath,
          ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
          commits: new Set(),
        }
        result.set(threadId, entry)
      }
      entry.commits.add(commit)
    }
    for (const row of sqliteRows<CheckpointRow>(this.#db.prepare('SELECT * FROM checkpoints')))
      add(row.thread_id, row.commit_sha)
    for (const row of sqliteRows<RestoreUndoRow>(this.#db.prepare('SELECT * FROM restore_undos'))) {
      add(row.thread_id, row.snapshot_commit)
      for (const checkpoint of StoredCheckpointRowsSchema.parse(JSON.parse(row.checkpoints_json)))
        add(row.thread_id, checkpoint.commit_sha)
    }
    return [...result.values()]
  }

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
    return sqliteRows<CheckpointRow>(
      this.#db.prepare(`SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY seq`),
      threadId,
    ).map((row) => {
      return {
        id: Number(row.id),
        threadId: row.thread_id,
        seq: Number(row.seq),
        commit: row.commit_sha,
        label: row.label,
        createdAt: Number(row.created_at),
      }
    })
  }

  checkpoint(id: number): StoredCheckpoint | undefined {
    const row = sqliteRow<CheckpointRow>(
      this.#db.prepare(`SELECT * FROM checkpoints WHERE id = ?`),
      id,
    )
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
    this.#deleteReplaySnapshot.run(threadId)
    this.#deleteCachedReplaySnapshot(threadId)
    this.#db
      .prepare(
        `DELETE FROM session_search
         WHERE rowid IN (SELECT seq FROM events WHERE thread_id = ? AND seq > ?)`,
      )
      .run(threadId, seq)
    this.#searchRevision += 1
    this.#db.prepare(`DELETE FROM events WHERE thread_id = ? AND seq > ?`).run(threadId, seq)
    this.#db.prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND seq > ?`).run(threadId, seq)
    // The inbox index keeps only current state. Rebuild this one thread so a
    // removed resolution or terminal event exposes the retained state again.
    this.#rebuildThreadInboxState(threadId)
    // Terminal rows are compact tombstones. Rebuild this one thread so a
    // removed terminal event exposes the retained start again.
    this.#rebuildThreadRecoveryState(threadId)
  }

  /** Save and remove the conversation tail so a restore remains reversible. */
  saveRestoreUndo(threadId: string, seq: number, commit: string): string {
    const token = randomUUID()
    const events = sqliteRows<EventRow>(
      this.#db.prepare(`SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq`),
      threadId,
      seq,
    )
    const checkpoints = sqliteRows<CheckpointRow>(
      this.#db.prepare(`SELECT * FROM checkpoints WHERE thread_id = ? AND seq > ? ORDER BY seq`),
      threadId,
      seq,
    )

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
    const row = sqliteRow<SnapshotCommitRow>(
      this.#db.prepare(
        `SELECT snapshot_commit FROM restore_undos WHERE thread_id = ? AND token = ?`,
      ),
      threadId,
      token,
    )
    if (!row) return undefined
    return { commit: row.snapshot_commit }
  }

  /** Put back the exact event/checkpoint rows removed by the latest restore. */
  applyRestoreUndo(threadId: string, token: string): void {
    const row = sqliteRow<RestoreUndoRow>(
      this.#db.prepare(`SELECT * FROM restore_undos WHERE thread_id = ? AND token = ?`),
      threadId,
      token,
    )
    if (!row) throw new Error('restore can no longer be undone')
    if (this.lastSeq(threadId) > Number(row.checkpoint_seq)) {
      throw new Error('restore can only be undone before the session continues')
    }

    const events = StoredEventRowsSchema.parse(JSON.parse(row.events_json))
    const checkpoints = StoredCheckpointRowsSchema.parse(JSON.parse(row.checkpoints_json))

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#deleteReplaySnapshot.run(threadId)
      this.#deleteCachedReplaySnapshot(threadId)
      const insertEvent = this.#db.prepare(
        `INSERT INTO events (seq, thread_id, at, payload) VALUES (?, ?, ?, ?)`,
      )
      for (const event of events) {
        insertEvent.run(event.seq, event.thread_id, event.at, event.payload)
        // The row is restored verbatim even when this build cannot read it —
        // the transcript is the user's; only derived indexing is skipped.
        const parsed = parseDomainEvent(
          event.payload,
          `restored transcript for thread ${event.thread_id}`,
        )
        if (parsed === undefined) continue
        this.#indexEvent(event.seq, event.thread_id, event.at, parsed)
        if (parsed.type === 'usage.updated') {
          this.#indexUsageEvent(event.seq, event.thread_id, event.at, event.payload)
        }
        if (affectsInboxProjection(parsed)) {
          this.#indexInboxEvent(event.seq, event.thread_id, parsed, event.payload)
        }
        const userSubmissionId = userSubmissionItemId(parsed)
        if (userSubmissionId) {
          this.#indexUserSubmission(event.seq, event.thread_id, userSubmissionId)
        }
        if (parsed.type === 'diff.updated') {
          this.#indexTurnDiff(event.seq, event.thread_id, parsed.turnId)
        }
        const recovery = recoveryMutation(parsed)
        if (recovery) {
          this.#indexRecoveryMutation(event.seq, event.thread_id, recovery, event.payload)
        }
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
    const row = sqliteRow<MaxSequenceRow>(this.#lastSequence, threadId)
    const seq = row?.seq ?? null
    return seq ? Number(seq) : 0
  }
}

function searchableEntry(event: DomainEvent): SearchableEntry | undefined {
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

function userSubmissionItemId(event: DomainEvent): string | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined
  return event.item.type === 'message' && event.item.role === 'user' ? event.item.id : undefined
}

function recoveryMutation(event: DomainEvent): RecoveryMutation | undefined {
  switch (event.type) {
    case 'turn.started':
      return {
        kind: 'start',
        eventType: event.type,
        lifecycleKey: `turn:${event.turn.id}`,
      }
    case 'turn.completed':
      return { kind: 'terminal', lifecycleKey: `turn:${event.turnId}` }
    case 'item.started':
      return {
        kind: 'start',
        eventType: event.type,
        lifecycleKey: `item:${event.item.id}`,
      }
    case 'item.completed':
      return { kind: 'terminal', lifecycleKey: `item:${event.item.id}` }
    case 'approval.requested':
      return {
        kind: 'start',
        eventType: event.type,
        lifecycleKey: `approval:${event.request.id}`,
      }
    case 'approval.resolved':
      return { kind: 'terminal', lifecycleKey: `approval:${event.id}` }
    case 'user_input.requested':
      return {
        kind: 'start',
        eventType: event.type,
        lifecycleKey: `input:${event.request.id}`,
      }
    case 'user_input.resolved':
      return { kind: 'terminal', lifecycleKey: `input:${event.id}` }
    case 'approval.review.started':
      return {
        kind: 'start',
        eventType: event.type,
        lifecycleKey: `review:${event.review.id}`,
      }
    case 'approval.review.completed':
      return { kind: 'terminal', lifecycleKey: `review:${event.review.id}` }
    case 'thread.error':
      return { kind: 'error' }
    default:
      return undefined
  }
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

function searchTerms(query: string): string[] {
  const terms = query.normalize('NFKC').toLowerCase().match(SEARCH_TOKEN) ?? []
  return [...new Set(terms)]
}

function asciiFtsTextTokens(value: string): string[] | undefined {
  if (value.length > SEARCH_SNAPSHOT_REUSE_SCAN_LIMIT || !ASCII_SEARCH_TEXT.test(value)) {
    return undefined
  }
  return value.toLowerCase().match(ASCII_FTS_TEXT_TOKEN) ?? []
}

function asciiFtsTokensDefinitelyMiss(search: readonly string[], text: readonly string[]): boolean {
  for (const term of search) {
    if (!ASCII_FTS_SEARCH_TERM.test(term)) continue
    if (!text.some((token) => token.startsWith(term))) return true
  }
  return false
}

function toFtsQuery(terms: readonly string[]): string {
  return terms.map((term) => `("${term}" OR "${term}"*)`).join(' AND ')
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

export function createSearchSnippet(
  value: string,
  terms: readonly string[],
): SessionSearchResult['snippet'] {
  return createSearchSnippetWithComparableTerms(value, terms.map(comparableSearchToken))
}

function createSearchSnippetWithComparableTerms(
  value: string,
  comparableTerms: readonly string[],
): SessionSearchResult['snippet'] {
  const asciiMatcher = asciiSnippetMatcher(value, comparableTerms)
  if (asciiMatcher) return createAsciiSearchSnippet(value, comparableTerms, asciiMatcher)

  const tokenLimit = 24
  const recentLimit = tokenLimit - 1
  const recent: SearchSnippetToken[] = []
  const firstTokens: SearchSnippetToken[] = []
  const iterator = value.matchAll(SEARCH_TOKEN)[Symbol.iterator]()
  let recentStart = 0
  let tokenCount = 0
  let firstMatch = -1
  let selectedPriorCount = 0
  let preceding: SearchSnippetToken[] = []
  let tokens: SearchSnippetToken[] | undefined
  let endsAtValueEnd = true

  while (true) {
    const next = iterator.next()
    if (next.done) break
    const match = next.value
    const start = match.index
    const text = match[0]
    const token = {
      start,
      end: start + text.length,
      highlighted: comparableTerms.some((term) => comparableSearchToken(text).startsWith(term)),
    }
    const tokenIndex = tokenCount
    tokenCount += 1

    if (tokens) {
      tokens.push(token)
      if (tokens.length < tokenLimit) continue
      endsAtValueEnd = iterator.next().done === true
      break
    }

    if (firstTokens.length < tokenLimit) firstTokens.push(token)
    if (token.highlighted) {
      firstMatch = tokenIndex
      preceding =
        recentStart === 0
          ? recent.slice()
          : [...recent.slice(recentStart), ...recent.slice(0, recentStart)]
      selectedPriorCount = Math.min(6, preceding.length)
      tokens = [...preceding.slice(-selectedPriorCount), token]
      continue
    }

    if (recent.length < recentLimit) recent.push(token)
    else {
      recent[recentStart] = token
      recentStart = (recentStart + 1) % recentLimit
    }
  }

  if (tokenCount === 0) return [{ text: value, highlighted: false }]

  let firstToken = 0
  if (!tokens) {
    tokens = firstTokens
    endsAtValueEnd = tokenCount <= tokenLimit
  } else {
    if (endsAtValueEnd && tokens.length < tokenLimit) {
      const unselectedPriorCount = preceding.length - selectedPriorCount
      const additionalPriorCount = Math.min(tokenLimit - tokens.length, unselectedPriorCount)
      if (additionalPriorCount > 0) {
        const end = preceding.length - selectedPriorCount
        tokens = [...preceding.slice(end - additionalPriorCount, end), ...tokens]
        selectedPriorCount += additionalPriorCount
      }
    }
    firstToken = firstMatch - selectedPriorCount
  }

  return formatSearchSnippet(value, tokens, firstToken === 0, endsAtValueEnd)
}

function asciiSnippetMatcher(
  value: string,
  comparableTerms: readonly string[],
): RegExp | undefined {
  if (
    comparableTerms.length === 0 ||
    !comparableTerms.every((term) => ASCII_COMPARABLE_SEARCH_TERM.test(term))
  ) {
    return undefined
  }
  const matcher = new RegExp(comparableTerms.join('|'), 'gi')
  const firstRawMatch = matcher.exec(value)
  if (firstRawMatch && firstRawMatch.index < ASCII_SNIPPET_SCAN_THRESHOLD) return undefined
  if (!ASCII_SEARCH_TEXT.test(value)) return undefined
  matcher.lastIndex = 0
  return matcher
}

function createAsciiSearchSnippet(
  value: string,
  comparableTerms: readonly string[],
  matcher: RegExp,
): SessionSearchResult['snippet'] {
  const firstMatch = firstAsciiSearchMatch(value, matcher)
  if (firstMatch === undefined) {
    const tokens = nextAsciiSearchTokens(value, 0, 25)
    return formatSearchSnippet(
      value,
      highlightAsciiSearchTokens(value, tokens.slice(0, 24), comparableTerms),
      true,
      tokens.length <= 24,
    )
  }

  const matched = nextAsciiSearchToken(value, firstMatch)
  if (!matched) return [{ text: value, highlighted: false }]

  const previous: SearchSnippetToken[] = []
  let cursor = matched.start
  while (previous.length < 24) {
    const token = previousAsciiSearchToken(value, cursor)
    if (!token) break
    previous.push(token)
    cursor = token.start
  }
  const following = nextAsciiSearchTokens(value, matched.end, 24)
  const selectedFollowingCount = Math.min(17, following.length)
  const selectedPriorCount = Math.min(23 - selectedFollowingCount, previous.length)
  const selected = [
    ...previous.slice(0, selectedPriorCount).reverse(),
    matched,
    ...following.slice(0, 23 - selectedPriorCount),
  ]
  const selectedFollowing = selected.length - selectedPriorCount - 1
  return formatSearchSnippet(
    value,
    highlightAsciiSearchTokens(value, selected, comparableTerms),
    previous.length <= selectedPriorCount,
    following.length <= selectedFollowing,
  )
}

function firstAsciiSearchMatch(value: string, matcher: RegExp): number | undefined {
  let match = matcher.exec(value)
  while (match) {
    if (isAsciiSearchTokenStart(value, match.index)) return match.index
    match = matcher.exec(value)
  }
  return undefined
}

function isAsciiSearchTokenStart(value: string, index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0 && value.charCodeAt(cursor) === 95) cursor -= 1
  return cursor < 0 || !isAsciiSearchTokenInitial(value.charCodeAt(cursor))
}

function nextAsciiSearchTokens(value: string, from: number, limit: number): SearchSnippetToken[] {
  const tokens: SearchSnippetToken[] = []
  let cursor = from
  while (tokens.length < limit) {
    const token = nextAsciiSearchToken(value, cursor)
    if (!token) break
    tokens.push(token)
    cursor = token.end
  }
  return tokens
}

function nextAsciiSearchToken(value: string, from: number): SearchSnippetToken | undefined {
  let start = from
  while (start < value.length && !isAsciiSearchTokenInitial(value.charCodeAt(start))) start += 1
  if (start >= value.length) return undefined
  let end = start + 1
  while (end < value.length && isAsciiSearchTokenContinuation(value.charCodeAt(end))) end += 1
  return { start, end, highlighted: false }
}

function previousAsciiSearchToken(value: string, before: number): SearchSnippetToken | undefined {
  let end = before
  while (end > 0) {
    let cursor = end - 1
    while (cursor >= 0 && !isAsciiSearchTokenContinuation(value.charCodeAt(cursor))) cursor -= 1
    if (cursor < 0) return undefined
    const tokenEnd = cursor + 1
    while (cursor >= 0 && isAsciiSearchTokenContinuation(value.charCodeAt(cursor))) cursor -= 1
    const runStart = cursor + 1
    let start = runStart
    while (start < tokenEnd && !isAsciiSearchTokenInitial(value.charCodeAt(start))) start += 1
    if (start < tokenEnd) return { start, end: tokenEnd, highlighted: false }
    end = runStart
  }
  return undefined
}

function isAsciiSearchTokenInitial(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiSearchTokenContinuation(code: number): boolean {
  return code === 95 || isAsciiSearchTokenInitial(code)
}

function highlightAsciiSearchTokens(
  value: string,
  tokens: readonly SearchSnippetToken[],
  comparableTerms: readonly string[],
): SearchSnippetToken[] {
  return tokens.map((token) => ({
    ...token,
    highlighted: comparableTerms.some((term) =>
      value.slice(token.start, token.end).toLowerCase().startsWith(term),
    ),
  }))
}

function formatSearchSnippet(
  value: string,
  tokens: readonly SearchSnippetToken[],
  startsAtValueStart: boolean,
  endsAtValueEnd: boolean,
): SessionSearchResult['snippet'] {
  if (tokens.length === 0) return [{ text: value, highlighted: false }]
  const start = startsAtValueStart ? 0 : tokens[0]!.start
  const end = endsAtValueEnd ? value.length : tokens.at(-1)!.end
  const parts: SessionSearchResult['snippet'] = []
  const append = (text: string, highlighted: boolean) => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.highlighted === highlighted) previous.text += text
    else parts.push({ text, highlighted })
  }

  if (start > 0) append('… ', false)
  let cursor = start
  for (const token of tokens) {
    append(value.slice(cursor, token.start), false)
    append(value.slice(token.start, token.end), token.highlighted)
    cursor = token.end
  }
  append(value.slice(cursor, end), false)
  if (end < value.length) append(' …', false)
  return parts.length > 0 ? parts : [{ text: value, highlighted: false }]
}

function comparableSearchToken(value: string): string {
  if (ASCII_SEARCH_TOKEN.test(value)) return value.toLowerCase()
  return value.normalize('NFKD').toLowerCase().replace(SEARCH_COMBINING_MARK, '')
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
    ...(!(costUsd === undefined) ? { costUsd } : {}),
  }
}

function toProject(row: ProjectRow): StoredProject {
  return {
    path: row.path,
    name: row.name,
    pinned: row.pinned === 1,
    createdAt: Number(row.created_at),
  }
}

function toQueuedTurn(row: QueuedTurnRow): StoredQueuedTurn | undefined {
  let payload: z.infer<typeof StoredQueuedTurnPayloadSchema> | undefined
  try {
    const parsed = StoredQueuedTurnPayloadSchema.safeParse(JSON.parse(row.payload))
    if (parsed.success) payload = parsed.data
  } catch {
    // Malformed JSON falls through to the same tombstone below.
  }
  if (payload === undefined) {
    // A queued prompt only a newer build can read. There is no honest
    // fallback for missing text, so the row becomes a tombstone: still
    // stored, skipped by list reads, never dispatched half-read.
    console.warn(
      `[store] skipped a queued turn this build cannot read (thread ${row.thread_id}, queue ${row.queue_id})`,
    )
    return undefined
  }
  return {
    id: row.queue_id,
    threadId: row.thread_id,
    ...(row.client_submission_id === null ? {} : { clientSubmissionId: row.client_submission_id }),
    text: payload.text,
    attachments: payload.attachments,
    options: payload.options,
    createdAt: Number(row.created_at),
    intent: queuedTurnIntent(row.intent),
  }
}

/**
 * Read one stored event without letting a row this build cannot interpret
 * deny the rest of the log. The table is shared across builds: a payload a
 * newer version wrote fails this schema, and the row becomes a tombstone —
 * still stored, skipped by every reader.
 */
function parseDomainEvent(serialized: string, context: string): DomainEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    console.warn(`[store] ${context}: skipped a stored event with malformed JSON`)
    return undefined
  }
  // item.delta stays hand-checked: hundreds a second and zod never sees them.
  if (value !== null && typeof value === 'object') {
    const event = value as Record<string, unknown>
    if (
      event.type === 'item.delta' &&
      typeof event.turnId === 'string' &&
      typeof event.itemId === 'string' &&
      typeof event.textDelta === 'string'
    ) {
      return {
        type: 'item.delta',
        turnId: event.turnId,
        itemId: event.itemId,
        textDelta: event.textDelta,
      }
    }
  }
  const parsed = DomainEventSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const type =
    value !== null && typeof value === 'object' ? (value as { type?: unknown }).type : undefined
  console.warn(
    `[store] ${context}: skipped a stored event this build cannot read` +
      (typeof type === 'string' ? ` (type '${type}')` : ''),
  )
  return undefined
}

function toProviderId(provider: string): ProviderId | undefined {
  switch (provider) {
    case 'codex':
    case 'claude-code':
    case 'grok':
    case 'cursor':
    case 'opencode':
    case 'antigravity':
    case 'pi':
    case 'acp':
    case 'api':
      return provider
    default: {
      const parsed = ProviderIdSchema.safeParse(provider)
      if (parsed.success) return parsed.data
      // A provider only a newer build knows. The row stays stored; readers
      // skip it rather than die on it.
      console.warn(`[store] skipped a thread row with unknown provider '${provider}'`)
      return undefined
    }
  }
}

function isLifecycleReason(reason: string): reason is 'manual' | 'inactivity' | 'change_request' {
  return reason === 'manual' || reason === 'inactivity' || reason === 'change_request'
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

const ACTIVE_LIFECYCLE = Object.freeze({ state: 'active' as const, keepActive: false })
const KEPT_ACTIVE_LIFECYCLE = Object.freeze({ state: 'active' as const, keepActive: true })

function activeLifecycle(keepActive: boolean, wokeAt: number | undefined): ThreadLifecycle {
  if (wokeAt === undefined) return keepActive ? KEPT_ACTIVE_LIFECYCLE : ACTIVE_LIFECYCLE
  return { state: 'active', keepActive, wokeAt }
}

/** Corrupt stored timestamps normalize to 0 rather than fail the whole row. */
function storedTimestamp(value: SqliteInteger): number {
  const parsed = Number(value)
  return isNonnegativeInteger(parsed) ? parsed : 0
}

function toActiveLifecycle(row: ActiveLifecycleRow): ThreadLifecycle {
  const wokeAt = row.woke_at === null ? undefined : Number(row.woke_at)
  return activeLifecycle(
    row.keep_active === 1,
    wokeAt !== undefined && isNonnegativeInteger(wokeAt) ? wokeAt : undefined,
  )
}

function toThreadLifecycle(row: ThreadLifecycleRow): ThreadLifecycle {
  if (row.lifecycle_state === 'settled') {
    const reason = row.lifecycle_reason ?? 'manual'
    return {
      state: 'settled',
      settledAt: storedTimestamp(row.lifecycle_at ?? row.created_at),
      reason: isLifecycleReason(reason) ? reason : 'manual',
    }
  }

  if (row.lifecycle_state === 'snoozed') {
    return {
      state: 'snoozed',
      snoozedAt: storedTimestamp(row.lifecycle_at ?? row.created_at),
      wakeAt: storedTimestamp(row.wake_at ?? row.created_at),
    }
  }

  if (row.lifecycle_state === 'active') {
    return toActiveLifecycle(row)
  }

  // A lifecycle state only a newer build understands: report the thread as
  // plainly active rather than hide it or fail every list it appears in.
  console.warn(`[store] unknown lifecycle state '${row.lifecycle_state}', treating as active`)
  return activeLifecycle(row.keep_active === 1, undefined)
}

function toSidebarThread(row: SidebarThreadRow): StoredSidebarThread | undefined {
  const provider = toProviderId(row.provider)
  // A thread this build cannot attribute stays in the table; it just has no
  // honest place in a sidebar rendered from the provider contract.
  if (provider === undefined) return undefined
  return {
    id: row.id,
    projectPath: row.project_path,
    provider,
    ...(row.agent === null ? {} : { agent: row.agent }),
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: Number(row.created_at),
    ...(row.closed_at === null ? {} : { closedAt: Number(row.closed_at) }),
    ...(row.worktree_branch === null ? {} : { worktreeBranch: row.worktree_branch }),
    lifecycle: toThreadLifecycle(row),
    unread: row.unread === 1,
  }
}

function toThread(row: ThreadRow): StoredThread | undefined {
  // Null timestamps (rows migrated before these columns existed) must not
  // become NaN — a snoozed thread with NaN wakeAt can never be woken.
  const lifecycle = toThreadLifecycle(row)
  const provider = toProviderId(row.provider)
  if (provider === undefined) return undefined
  return {
    id: row.id,
    projectPath: row.project_path,
    provider,
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.provider_session_id === null ? {} : { providerSessionId: row.provider_session_id }),
    title: row.title,
    pinned: row.pinned === 1,
    createdAt: Number(row.created_at),
    ...(row.closed_at === null ? {} : { closedAt: Number(row.closed_at) }),
    ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
    ...(row.worktree_branch === null ? {} : { worktreeBranch: row.worktree_branch }),
    lifecycle,
    unread: row.unread === 1,
    lastActiveAt: Number(row.last_active_at),
    ephemeral: row.ephemeral === 1,
    ...(row.parent_thread_id === null ? {} : { parentThreadId: row.parent_thread_id }),
  }
}

function sqliteRows<Row>(statement: StatementSync, ...params: SQLInputValue[]): Row[] {
  return statement.all(...params) as Row[]
}

function sqliteRow<Row>(statement: StatementSync, ...params: SQLInputValue[]): Row | undefined {
  return statement.get(...params) as Row | undefined
}

function requiredSqliteRow<Row>(statement: StatementSync, ...params: SQLInputValue[]): Row {
  const row = sqliteRow<Row>(statement, ...params)
  if (!row) throw new Error('SQLite query returned no row')
  return row
}

function queuedTurnIntent(value: string): StoredQueuedTurn['intent'] {
  if (value === 'normal' || value === 'steer') return value
  // Runs in the constructor's claim recovery: one intent only a newer build
  // wrote must not keep the store from opening. A normal turn is the honest
  // degradation — the prompt still runs, just without steer semantics.
  console.warn(`[store] unknown queued turn intent '${value}', treating as normal`)
  return 'normal'
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('value cannot be stored as JSON')
  return serialized
}

function parseJsonValue(serialized: string): JsonValue {
  // SAFETY: JSON.parse can return only JSON primitives, arrays, and objects.
  return JSON.parse(serialized) as JsonValue
}
