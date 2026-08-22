import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-bench-'))
const databasePath = path.join(directory, 'events.db')
const store = new Store(databasePath)
store.addProject('/benchmark')
store.addThread({
  id: 'thread-1',
  projectPath: '/benchmark',
  provider: 'codex',
  title: 'Recovery benchmark',
})
store.append('thread-1', {
  type: 'turn.started',
  turn: { id: 'open-turn', threadId: 'thread-1', status: 'running', createdAt: 1 },
})

const delta = {
  type: 'item.delta' as const,
  turnId: 'open-turn',
  itemId: 'answer-1',
  textDelta: 'x',
}
for (let offset = 0; offset < 100_000; offset += 1_000) {
  store.appendBatch(Array.from({ length: 1_000 }, () => ({ threadId: 'thread-1', event: delta })))
}

const raw = new DatabaseSync(databasePath)
const legacyRecovery = raw.prepare(
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
   SELECT started.thread_id, started.payload
   FROM lifecycle_state
   INNER JOIN lifecycle_events AS started ON started.seq = lifecycle_state.started_seq
   LEFT JOIN last_errors ON last_errors.thread_id = started.thread_id
   WHERE lifecycle_state.terminal_seq IS NULL
     AND (started.event_type <> 'turn.started' OR last_errors.seq IS NULL
          OR last_errors.seq < started.seq)
   ORDER BY started.seq`,
)
const indexedRecovery = raw.prepare(
  `SELECT recovery.thread_id, recovery.payload
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

afterAll(() => {
  raw.close()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

function assertOneRow(rows: unknown[]): void {
  if (rows.length !== 1) throw new Error(`expected one active lifecycle, received ${rows.length}`)
}

describe('long-thread interrupted-state startup scan', () => {
  bench('classifies all 100,000 event payloads', () => assertOneRow(legacyRecovery.all()), OPTIONS)
  bench('reads only active lifecycle rows', () => assertOneRow(indexedRecovery.all()), OPTIONS)
})
