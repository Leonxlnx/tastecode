import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-turn-diff-bench-'))
const databasePath = path.join(directory, 'events.db')
const store = new Store(databasePath)
store.addProject('/benchmark')
store.addThread({
  id: 'thread-1',
  projectPath: '/benchmark',
  provider: 'codex',
  title: 'Turn diff benchmark',
})
store.append('thread-1', { type: 'diff.updated', turnId: 'old-turn', diff: 'old patch' })

const delta = {
  type: 'item.delta' as const,
  turnId: 'latest-turn',
  itemId: 'answer-1',
  textDelta: 'x',
}
for (let offset = 0; offset < 100_000; offset += 1_000) {
  store.appendBatchWithSerializedEvents(
    Array.from({ length: 1_000 }, () => ({ threadId: 'thread-1', event: delta })),
  )
}

const raw = new DatabaseSync(databasePath)
const legacyTurnDiff = raw.prepare(
  `SELECT payload FROM events
   WHERE thread_id = ?
     AND json_extract(payload, '$.type') = 'diff.updated'
     AND json_extract(payload, '$.turnId') = ?
   ORDER BY seq DESC LIMIT 1`,
)

afterAll(() => {
  raw.close()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('old-turn diff lookup in a long thread', () => {
  bench(
    'scans JSON across 100,000 newer events',
    () => {
      if (!legacyTurnDiff.get('thread-1', 'old-turn')) throw new Error('missing diff')
    },
    OPTIONS,
  )

  bench(
    'reads one indexed turn diff',
    () => {
      if (store.turnDiff('thread-1', 'old-turn') !== 'old patch') throw new Error('missing diff')
    },
    OPTIONS,
  )
})
