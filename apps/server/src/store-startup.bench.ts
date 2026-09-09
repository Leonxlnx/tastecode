import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const database = new DatabaseSync(':memory:')
database.exec(`
  CREATE TABLE projects (path TEXT PRIMARY KEY, pinned INTEGER);
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    pinned INTEGER,
    worktree_path TEXT,
    worktree_branch TEXT,
    lifecycle_state TEXT,
    lifecycle_at INTEGER,
    lifecycle_reason TEXT,
    wake_at INTEGER,
    keep_active INTEGER,
    woke_at INTEGER,
    unread INTEGER,
    last_active_at INTEGER,
    ephemeral INTEGER,
    parent_thread_id TEXT,
    provider_session_id TEXT
  );
  INSERT INTO threads (id) VALUES ('thread-1');
`)

const migrationTables = [
  'projects',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
  'threads',
]

function repeatedSchemaReads(): void {
  for (const table of migrationTables) database.prepare(`PRAGMA table_info(${table})`).all()
}

function groupedSchemaReads(): void {
  for (const table of new Set(migrationTables)) {
    database.prepare(`PRAGMA table_info(${table})`).all()
  }
}

const findThread = database.prepare(`SELECT * FROM threads WHERE id = ?`)
const cachedStore = new Store(':memory:')
cachedStore.addProject('/repo')
cachedStore.addThread({
  id: 'thread-1',
  projectPath: '/repo',
  provider: 'codex',
  title: 'Thread',
})
cachedStore.addThread({
  id: 'thread-2',
  projectPath: '/repo',
  provider: 'codex',
  title: 'Thread 2',
})
cachedStore.addThread({
  id: 'thread-3',
  projectPath: '/repo',
  provider: 'codex',
  title: 'Thread 3',
})
let threadMetadataReadSink = cachedStore.thread('thread-1')?.title
let alternatingThreadMetadataReadSink = cachedStore.thread('thread-2')?.title
let rotatingThreadMetadataReadSink = cachedStore.thread('thread-3')?.title
const retainedThreadIds = ['thread-1', 'thread-2', 'thread-3'] as const
const queueDatabase = new DatabaseSync(':memory:')
queueDatabase.exec(`
  CREATE TABLE queued_turn_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    queue_id TEXT,
    at INTEGER NOT NULL,
    mutation TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE queued_turns (
    thread_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL,
    intent TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, queue_id)
  );
`)
const insertQueuedTurnEvent = queueDatabase.prepare(
  `INSERT INTO queued_turn_events (thread_id, queue_id, at, mutation, payload)
   VALUES (?, ?, ?, ?, ?)`,
)
const insertQueuedTurn = queueDatabase.prepare(
  `INSERT INTO queued_turns
     (thread_id, queue_id, position, state, intent, payload, created_at)
   VALUES (?, ?, ?, 'queued', 'normal', '{}', ?)`,
)
const findQueuedTurn = queueDatabase.prepare(
  `SELECT 1 FROM queued_turns
   WHERE thread_id = ? AND queue_id = ? AND state = 'queued'`,
)
const dispatchQueuedTurn = queueDatabase.prepare(
  `UPDATE queued_turns SET state = 'dispatching' WHERE thread_id = ? AND queue_id = ?`,
)
const deleteQueuedTurn = queueDatabase.prepare(
  `DELETE FROM queued_turns WHERE thread_id = ? AND queue_id = ?`,
)
const purgeDatabase = new DatabaseSync(':memory:')
purgeDatabase.exec(`
  CREATE TABLE threads (id TEXT PRIMARY KEY, ephemeral INTEGER NOT NULL);
  CREATE TABLE session_search (thread_id TEXT);
  CREATE TABLE events (thread_id TEXT);
  CREATE TABLE checkpoints (thread_id TEXT);
  CREATE TABLE restore_undos (thread_id TEXT);
  CREATE TABLE diff_decisions (thread_id TEXT);
  CREATE TABLE design_runs (thread_id TEXT);
  BEGIN;
`)
const purgeTables = [
  'session_search',
  'events',
  'checkpoints',
  'restore_undos',
  'diff_decisions',
  'design_runs',
] as const
const insertPurgeThread = purgeDatabase.prepare(`INSERT INTO threads VALUES (?, 1)`)
const insertPurgeRows = new Map(
  purgeTables.map((table) => [
    table,
    purgeDatabase.prepare(`INSERT INTO ${table} (thread_id) VALUES (?)`),
  ]),
)
for (let index = 0; index < 1_000; index += 1) {
  const id = `side-${index}`
  insertPurgeThread.run(id)
  for (const insert of insertPurgeRows.values()) insert.run(id)
}
purgeDatabase.exec('COMMIT')

function repeatedThreadPrepare(): void {
  for (let index = 0; index < 10_000; index += 1) {
    database.prepare(`SELECT * FROM threads WHERE id = ?`).get('thread-1')
  }
}

function retainedThreadStatement(): void {
  for (let index = 0; index < 10_000; index += 1) findThread.get('thread-1')
}

function retainedThreadMetadata(): void {
  let thread: ReturnType<Store['thread']> = undefined
  for (let index = 0; index < 10_000; index += 1) thread = cachedStore.thread('thread-1')
  threadMetadataReadSink = thread?.title
}

function alternatingRetainedThreadMetadata(): void {
  let thread: ReturnType<Store['thread']> = undefined
  for (let index = 0; index < 10_000; index += 1) {
    thread = cachedStore.thread(index % 2 === 0 ? 'thread-1' : 'thread-2')
  }
  alternatingThreadMetadataReadSink = thread?.title
}

function rotatingRetainedThreadMetadata(): void {
  let thread: ReturnType<Store['thread']> = undefined
  for (let index = 0; index < 10_002; index += 1) {
    thread = cachedStore.thread(retainedThreadIds[index % retainedThreadIds.length]!)
  }
  rotatingThreadMetadataReadSink = thread?.title
}

function repeatedlyPrepareQueuedTurnInsert(): void {
  queueDatabase.exec('SAVEPOINT queue_benchmark')
  for (let index = 0; index < 10_000; index += 1) {
    queueDatabase
      .prepare(
        `INSERT INTO queued_turn_events (thread_id, queue_id, at, mutation, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('thread-1', `queue-${index}`, index, 'enqueue', '{}')
  }
  queueDatabase.exec('ROLLBACK TO queue_benchmark')
  queueDatabase.exec('RELEASE queue_benchmark')
}

function reuseQueuedTurnInsert(): void {
  queueDatabase.exec('SAVEPOINT queue_benchmark')
  for (let index = 0; index < 10_000; index += 1) {
    insertQueuedTurnEvent.run('thread-1', `queue-${index}`, index, 'enqueue', '{}')
  }
  queueDatabase.exec('ROLLBACK TO queue_benchmark')
  queueDatabase.exec('RELEASE queue_benchmark')
}

function repeatedlyPrepareQueueLifecycle(): void {
  queueDatabase.exec('SAVEPOINT queue_lifecycle_benchmark')
  for (let index = 0; index < 10_000; index += 1) {
    const id = `queue-${index}`
    queueDatabase
      .prepare(
        `INSERT INTO queued_turns
           (thread_id, queue_id, position, state, intent, payload, created_at)
         VALUES (?, ?, ?, 'queued', 'normal', '{}', ?)`,
      )
      .run('thread-1', id, index, index)
    queueDatabase
      .prepare(
        `SELECT 1 FROM queued_turns
         WHERE thread_id = ? AND queue_id = ? AND state = 'queued'`,
      )
      .get('thread-1', id)
    queueDatabase
      .prepare(`UPDATE queued_turns SET state = 'dispatching' WHERE thread_id = ? AND queue_id = ?`)
      .run('thread-1', id)
    queueDatabase
      .prepare(`DELETE FROM queued_turns WHERE thread_id = ? AND queue_id = ?`)
      .run('thread-1', id)
  }
  queueDatabase.exec('ROLLBACK TO queue_lifecycle_benchmark')
  queueDatabase.exec('RELEASE queue_lifecycle_benchmark')
}

function reuseQueueLifecycleStatements(): void {
  queueDatabase.exec('SAVEPOINT queue_lifecycle_benchmark')
  for (let index = 0; index < 10_000; index += 1) {
    const id = `queue-${index}`
    insertQueuedTurn.run('thread-1', id, index, index)
    findQueuedTurn.get('thread-1', id)
    dispatchQueuedTurn.run('thread-1', id)
    deleteQueuedTurn.run('thread-1', id)
  }
  queueDatabase.exec('ROLLBACK TO queue_lifecycle_benchmark')
  queueDatabase.exec('RELEASE queue_lifecycle_benchmark')
}

function purgeOneThreadAtATime(): void {
  purgeDatabase.exec('SAVEPOINT purge_benchmark')
  const ids = purgeDatabase.prepare(`SELECT id FROM threads WHERE ephemeral = 1`).all()
  for (const row of ids) {
    for (const table of purgeTables) {
      purgeDatabase.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(row['id']!)
    }
    purgeDatabase.prepare(`DELETE FROM threads WHERE id = ?`).run(row['id']!)
  }
  purgeDatabase.exec('ROLLBACK TO purge_benchmark')
  purgeDatabase.exec('RELEASE purge_benchmark')
}

function purgeAllThreadsTogether(): void {
  purgeDatabase.exec('SAVEPOINT purge_benchmark')
  for (const table of purgeTables) {
    purgeDatabase.exec(
      `DELETE FROM ${table}
       WHERE thread_id IN (SELECT id FROM threads WHERE ephemeral = 1)`,
    )
  }
  purgeDatabase.exec(`DELETE FROM threads WHERE ephemeral = 1`)
  purgeDatabase.exec('ROLLBACK TO purge_benchmark')
  purgeDatabase.exec('RELEASE purge_benchmark')
}

afterAll(() => {
  if (threadMetadataReadSink !== 'Thread') throw new Error('thread metadata benchmark failed')
  if (alternatingThreadMetadataReadSink !== 'Thread 2') {
    throw new Error('alternating thread metadata benchmark failed')
  }
  if (rotatingThreadMetadataReadSink !== 'Thread 3') {
    throw new Error('rotating thread metadata benchmark failed')
  }
  cachedStore.close()
  database.close()
  queueDatabase.close()
  purgeDatabase.close()
})

describe('store schema migration startup', () => {
  bench('reads table schema once per migrated column', repeatedSchemaReads, OPTIONS)
  bench('reads table schema once per table', groupedSchemaReads, OPTIONS)
})

describe('repeated thread metadata reads', () => {
  bench('prepares the thread query 10,000 times', repeatedThreadPrepare, {
    iterations: 7,
    time: 0,
    warmupIterations: 2,
    warmupTime: 0,
  })
  bench('reuses one prepared thread query 10,000 times', retainedThreadStatement, {
    iterations: 7,
    time: 0,
    warmupIterations: 2,
    warmupTime: 0,
  })
  bench('reuses retained thread metadata 10,000 times', retainedThreadMetadata, {
    iterations: 10,
    time: 500,
    warmupIterations: 5,
    warmupTime: 100,
  })
  bench(
    'alternates between two retained thread rows 10,000 times',
    alternatingRetainedThreadMetadata,
    {
      iterations: 10,
      time: 500,
      warmupIterations: 5,
      warmupTime: 100,
    },
  )
  bench('rotates across three retained thread rows 10,002 times', rotatingRetainedThreadMetadata, {
    iterations: 10,
    time: 500,
    warmupIterations: 5,
    warmupTime: 100,
  })
})

describe('queued turn audit writes', () => {
  bench('prepares the audit insert 10,000 times', repeatedlyPrepareQueuedTurnInsert, {
    iterations: 7,
    time: 0,
    warmupIterations: 2,
    warmupTime: 0,
  })
  bench('reuses one prepared audit insert 10,000 times', reuseQueuedTurnInsert, {
    iterations: 7,
    time: 0,
    warmupIterations: 2,
    warmupTime: 0,
  })
})

describe('queued turn lifecycle', () => {
  bench('prepares each statement across 10,000 queue lifecycles', repeatedlyPrepareQueueLifecycle, {
    iterations: 5,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  })
  bench('reuses statements across 10,000 queue lifecycles', reuseQueueLifecycleStatements, {
    iterations: 5,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  })
})

describe('crashed side-chat startup cleanup', () => {
  bench('deletes 1,000 side chats one at a time', purgeOneThreadAtATime, {
    iterations: 5,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  })
  bench('deletes 1,000 side chats in one batch', purgeAllThreadsTogether, {
    iterations: 5,
    time: 0,
    warmupIterations: 1,
    warmupTime: 0,
  })
})
