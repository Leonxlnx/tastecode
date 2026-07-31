import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DomainEvent, ProviderId, Usage } from '@harness/contracts'

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
  createdAt: number
  /** Set when the session was closed. Kept, not deleted — history outlives use. */
  closedAt?: number | undefined
  /**
   * The private checkout this session works in, when it was isolated. Stored
   * because a crash must not orphan a directory nobody remembers creating.
   */
  worktreePath?: string | undefined
  worktreeBranch?: string | undefined
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
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  worktree_path   TEXT,
  worktree_branch TEXT
);

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
  { table: 'threads', column: 'worktree_path', definition: 'TEXT' },
  { table: 'threads', column: 'worktree_branch', definition: 'TEXT' },
]

export class Store {
  #db: DatabaseSync

  /** `:memory:` in tests; a file under the user's data directory in the app. */
  constructor(location: string) {
    if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true })
    this.#db = new DatabaseSync(location)
    // Without WAL a reader blocks a writer, and we do both on every turn.
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(SCHEMA)
    this.#migrate()
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
  }

  close(): void {
    this.#db.close()
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

  /** Removes the project and every thread and event under it. */
  removeProject(projectPath: string): void {
    const ids = this.#db
      .prepare(`SELECT id FROM threads WHERE project_path = ?`)
      .all(projectPath)
      .map((row) => String((row as { id: unknown }).id))
    if (ids.some((id) => this.thread(id)?.worktreePath)) {
      throw new Error('discard isolated session checkouts before removing the project')
    }
    for (const id of ids) this.deleteThread(id)
    this.#db.prepare(`DELETE FROM projects WHERE path = ?`).run(projectPath)
  }

  // ---- threads -----------------------------------------------------------

  addThread(thread: Omit<StoredThread, 'createdAt'> & { createdAt?: number }): StoredThread {
    const stored: StoredThread = { ...thread, createdAt: thread.createdAt ?? Date.now() }
    this.#db
      .prepare(
        `INSERT INTO threads
           (id, project_path, provider, agent, title, created_at, worktree_path, worktree_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
    return stored
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
    this.#db.prepare(`DELETE FROM events WHERE thread_id = ?`).run(id)
    this.#db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(id)
    this.#db.prepare(`DELETE FROM restore_undos WHERE thread_id = ?`).run(id)
    this.#db.prepare(`DELETE FROM threads WHERE id = ?`).run(id)
  }

  // ---- events ------------------------------------------------------------

  /** Returns the sequence number, which is what a client resumes from. */
  append(threadId: string, event: DomainEvent): number {
    const result = this.#db
      .prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
      .run(threadId, Date.now(), JSON.stringify(event))
    return Number(result.lastInsertRowid)
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

  /** Persistent totals derived from the event log that already owns usage. */
  usageSummary(threadId: string, since: number): { session: UsageTotal; today: UsageTotal } {
    const thread = this.thread(threadId)
    if (!thread) return { session: emptyUsage(), today: emptyUsage() }

    const rows = this.#db
      .prepare(
        `SELECT events.thread_id, events.at, events.payload
         FROM events JOIN threads ON threads.id = events.thread_id
         WHERE threads.provider = ? ORDER BY events.thread_id, events.seq`,
      )
      .all(thread.provider) as Array<{ thread_id: string; at: number; payload: string }>
    const previous = new Map<string, UsageTotal>()
    let session = emptyUsage()
    let today = emptyUsage()

    for (const row of rows) {
      const event = JSON.parse(row.payload) as DomainEvent
      if (event.type !== 'usage.updated') continue
      const current = withoutContext(event.usage)
      // Codex reports a running thread total. Claude reports one completed turn.
      const increment =
        thread.provider === 'claude-code'
          ? current
          : usageIncrement(current, previous.get(row.thread_id))
      previous.set(row.thread_id, current)
      if (row.thread_id === threadId) session = addUsage(session, increment)
      if (Number(row.at) >= since) today = addUsage(today, increment)
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
    return this.checkpoints(
      String(
        (
          this.#db.prepare(`SELECT thread_id FROM checkpoints WHERE id = ?`).get(id) as
            { thread_id: string } | undefined
        )?.thread_id ?? '',
      ),
    ).find((entry) => entry.id === id)
  }

  /**
   * Drop everything after a point in the conversation.
   *
   * Rolling the files back without this would leave the thread describing work
   * that no longer exists on disk — the transcript and the repository telling
   * two different stories.
   */
  #truncateAfter(threadId: string, seq: number): void {
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

type UsageTotal = Omit<Usage, 'contextWindow'>

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
  const { contextWindow: _contextWindow, ...total } = usage
  return total
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
    current.costUsd === undefined
      ? undefined
      : delta(current.costUsd, previous.costUsd ?? 0)
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
    created_at: number
    closed_at: number | null
    worktree_path: string | null
    worktree_branch: string | null
  }
  return {
    id: r.id,
    projectPath: r.project_path,
    provider: r.provider as ProviderId,
    ...(r.agent === null ? {} : { agent: r.agent }),
    title: r.title,
    createdAt: Number(r.created_at),
    ...(r.closed_at === null ? {} : { closedAt: Number(r.closed_at) }),
    ...(r.worktree_path === null ? {} : { worktreePath: r.worktree_path }),
    ...(r.worktree_branch === null ? {} : { worktreeBranch: r.worktree_branch }),
  }
}
