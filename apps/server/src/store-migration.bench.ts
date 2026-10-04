import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'
import { DomainEventSchema } from '@harness/contracts'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 }
const database = new DatabaseSync(':memory:')
database.exec(`CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL
)`)
const insert = database.prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
const delta = JSON.stringify({
  type: 'item.delta',
  turnId: 'turn-1',
  itemId: 'answer-1',
  textDelta: 'x',
})

database.exec('BEGIN')
for (let index = 0; index < 100_000; index += 1) {
  insert.run('thread-1', index, delta)
  if (index % 1_000 !== 0) continue
  const turnId = `turn-${index}`
  for (const event of [
    {
      type: 'item.completed',
      item: {
        id: `message-${index}`,
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'searchable text',
        createdAt: index,
      },
    },
    {
      type: 'usage.updated',
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
      },
    },
    {
      type: 'turn.started',
      turn: { id: turnId, threadId: 'thread-1', status: 'running', createdAt: index },
    },
    { type: 'diff.updated', turnId, diff: 'patch' },
    { type: 'turn.completed', turnId, status: 'completed' },
  ]) {
    insert.run('thread-1', index, JSON.stringify(event))
  }
}
database.exec('COMMIT')

const searchScan = database.prepare(`SELECT payload FROM events ORDER BY seq`)
const usageScan = database.prepare(
  `SELECT payload FROM events WHERE json_extract(payload, '$.type') = 'usage.updated'`,
)
const inboxScan = database.prepare(
  `SELECT payload FROM events WHERE json_extract(payload, '$.type') IN (
    'approval.requested', 'approval.resolved', 'user_input.requested',
    'user_input.resolved', 'thread.error', 'turn.completed'
  )`,
)
const submissionScan = database.prepare(
  `SELECT payload FROM events WHERE json_extract(payload, '$.type') IN (
    'item.started', 'item.completed'
  )`,
)
const diffScan = database.prepare(
  `SELECT payload FROM events WHERE json_extract(payload, '$.type') = 'diff.updated'`,
)
const recoveryScan = database.prepare(
  `SELECT payload FROM events WHERE json_extract(payload, '$.type') IN (
    'turn.started', 'turn.completed', 'thread.error', 'item.started', 'item.completed',
    'approval.requested', 'approval.resolved', 'user_input.requested',
    'user_input.resolved', 'approval.review.started', 'approval.review.completed'
  )`,
)
const combinedScan = database.prepare(
  `SELECT payload FROM events WHERE json_extract(payload, '$.type') IN (
    'item.completed', 'usage.updated', 'approval.requested', 'approval.resolved',
    'user_input.requested', 'user_input.resolved', 'thread.error', 'turn.completed',
    'item.started', 'diff.updated', 'turn.started', 'approval.review.started',
    'approval.review.completed'
  )`,
)

afterAll(() => database.close())

function parseRows(rows: Array<Record<string, unknown>>): void {
  for (const row of rows) DomainEventSchema.parse(JSON.parse(String(row['payload'])))
}

describe('large event-log derived-index migration', () => {
  bench(
    'runs six legacy scans and validates every search candidate',
    () => {
      parseRows(searchScan.all())
      usageScan.all()
      inboxScan.all()
      submissionScan.all()
      diffScan.all()
      parseRows(recoveryScan.all())
    },
    OPTIONS,
  )

  bench(
    'runs one filtered scan and validates each useful event once',
    () => parseRows(combinedScan.all()),
    OPTIONS,
  )
})
