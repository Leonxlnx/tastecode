import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'

const OPTIONS = { iterations: 7, time: 0, warmupIterations: 2, warmupTime: 0 }
const database = new DatabaseSync(':memory:')
database.exec(`
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_by_thread ON events (thread_id, seq);
  CREATE TABLE usage_events (
    event_seq INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX usage_events_thread_seq ON usage_events (thread_id, event_seq);
  CREATE INDEX usage_events_at ON usage_events (at);
`)

const insertEvent = database.prepare(`INSERT INTO events (thread_id, at, payload) VALUES (?, ?, ?)`)
const insertUsage = database.prepare(
  `INSERT INTO usage_events (event_seq, thread_id, at, payload) VALUES (?, ?, ?, ?)`,
)
const delta = JSON.stringify({
  type: 'item.delta',
  turnId: 'turn',
  itemId: 'item',
  textDelta: 'streamed output',
})
const usage = JSON.stringify({
  type: 'usage.updated',
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
})

database.exec('BEGIN')
for (let index = 0; index < 100_000; index += 1) {
  const threadId = `thread-${index % 100}`
  const payload = index % 1_000 === 0 ? usage : delta
  const result = insertEvent.run(threadId, index, payload)
  if (payload === usage) insertUsage.run(result.lastInsertRowid, threadId, index, payload)
}
database.exec('COMMIT')

const legacySession = database.prepare(
  `SELECT payload FROM events
   WHERE thread_id = ? AND payload LIKE '%"usage.updated"%' ORDER BY seq`,
)
const indexedSession = database.prepare(
  `SELECT payload FROM usage_events WHERE thread_id = ? ORDER BY event_seq`,
)
const legacyDay = database.prepare(
  `SELECT thread_id, payload FROM events
   WHERE at >= ? AND payload LIKE '%"usage.updated"%' ORDER BY thread_id, seq`,
)
const indexedDay = database.prepare(
  `SELECT thread_id, payload FROM usage_events
   WHERE at >= ? ORDER BY thread_id, event_seq`,
)

afterAll(() => database.close())

describe('usage reads in a 100,000-event history', () => {
  bench(
    'scans long thread payloads for session usage',
    () => {
      legacySession.all('thread-0')
    },
    OPTIONS,
  )
  bench(
    'reads indexed session usage rows',
    () => {
      indexedSession.all('thread-0')
    },
    OPTIONS,
  )
  bench(
    'scans every recent payload for daily usage',
    () => {
      legacyDay.all(0)
    },
    OPTIONS,
  )
  bench(
    'reads indexed daily usage rows',
    () => {
      indexedDay.all(0)
    },
    OPTIONS,
  )
})
