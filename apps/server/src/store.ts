import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DomainEvent, ProviderId } from '@harness/contracts'

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
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  path       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  provider     TEXT NOT NULL,
  agent        TEXT,
  title        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread_id, seq);
CREATE INDEX IF NOT EXISTS threads_by_project ON threads (project_path);
`

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
  }

  close(): void {
    this.#db.close()
  }

  // ---- projects ----------------------------------------------------------

  addProject(projectPath: string, name?: string): StoredProject {
    const project: StoredProject = {
      path: projectPath,
      name: name ?? path.basename(projectPath),
      createdAt: Date.now(),
    }
    // Adding a project twice is a normal thing for a user to do; it must not
    // wipe the name they gave it.
    this.#db
      .prepare(
        `INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT (path) DO NOTHING`,
      )
      .run(project.path, project.name, project.createdAt)
    return this.project(projectPath) ?? project
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
    for (const id of ids) this.deleteThread(id)
    this.#db.prepare(`DELETE FROM projects WHERE path = ?`).run(projectPath)
  }

  // ---- threads -----------------------------------------------------------

  addThread(thread: Omit<StoredThread, 'createdAt'> & { createdAt?: number }): StoredThread {
    const stored: StoredThread = { ...thread, createdAt: thread.createdAt ?? Date.now() }
    this.#db
      .prepare(
        `INSERT INTO threads (id, project_path, provider, agent, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.id,
        stored.projectPath,
        stored.provider,
        stored.agent ?? null,
        stored.title,
        stored.createdAt,
      )
    return stored
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
    this.#db.prepare(`DELETE FROM events WHERE thread_id = ?`).run(id)
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

  lastSeq(threadId: string): number {
    const row = this.#db
      .prepare(`SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?`)
      .get(threadId)
    const seq = (row as { seq: number | null } | undefined)?.seq
    return seq ? Number(seq) : 0
  }
}

function toProject(row: unknown): StoredProject {
  const r = row as { path: string; name: string; created_at: number }
  return { path: r.path, name: r.name, createdAt: Number(r.created_at) }
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
  }
  return {
    id: r.id,
    projectPath: r.project_path,
    provider: r.provider as ProviderId,
    ...(r.agent === null ? {} : { agent: r.agent }),
    title: r.title,
    createdAt: Number(r.created_at),
    ...(r.closed_at === null ? {} : { closedAt: Number(r.closed_at) }),
  }
}
