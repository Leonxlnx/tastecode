import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from './store.js'

const ROW_COUNT = 100_000
const QUERY_COUNT = 32
const terms = Array.from({ length: QUERY_COUNT }, (_, index) => `snapshotterm${index}`)
const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-search-memory-'))
const location = path.join(directory, 'search.db')

function collect(): NodeJS.MemoryUsage {
  for (let index = 0; index < 3; index += 1) global.gc?.()
  return process.memoryUsage()
}

try {
  const seed = new Store(location)
  seed.addProject('/search-memory')
  seed.addThread({
    id: 'search-memory-thread',
    projectPath: '/search-memory',
    provider: 'codex',
    title: 'Search memory',
  })
  seed.close()

  const database = new DatabaseSync(location)
  const insert = database.prepare(
    `INSERT INTO session_search
       (rowid, thread_id, event_seq, turn_id, created_at, text)
     VALUES (?, 'search-memory-thread', ?, ?, ?, ?)`,
  )
  const text = terms.join(' ')
  database.exec('BEGIN IMMEDIATE')
  for (let index = 0; index < ROW_COUNT; index += 1) {
    const rowId = index + 1
    insert.run(rowId, rowId, `turn-${rowId}`, rowId, text)
  }
  database.exec('COMMIT')
  database.close()

  const store = new Store(location)
  const before = collect()
  for (const query of terms) {
    const page = store.searchSessions({ query, limit: 1 })
    if (page.results.length !== 1 || page.nextCursor === null) {
      throw new Error(`missing broad search results for ${query}`)
    }
  }
  const after = collect()
  console.log(
    JSON.stringify({
      rowsPerSnapshot: ROW_COUNT,
      queries: QUERY_COUNT,
      arrayBufferBytes: after.arrayBuffers - before.arrayBuffers,
      externalBytes: after.external - before.external,
      heapBytes: after.heapUsed - before.heapUsed,
      rssBytes: after.rss - before.rss,
    }),
  )
  store.close()
} finally {
  rmSync(directory, { recursive: true, force: true })
}
