import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const store = new Store(':memory:')
store.addProject('/benchmark')
store.addThread({
  id: 'thread-1',
  projectPath: '/benchmark',
  provider: 'codex',
  title: 'Submission benchmark',
})

const delta = {
  type: 'item.delta' as const,
  turnId: 'turn-1',
  itemId: 'answer-1',
  textDelta: 'x',
}
for (let offset = 0; offset < 100_000; offset += 1_000) {
  store.appendBatch(Array.from({ length: 1_000 }, () => ({ threadId: 'thread-1', event: delta })))
}
store.append('thread-1', {
  type: 'item.completed',
  item: {
    id: 'submission-1',
    turnId: 'turn-1',
    type: 'message',
    role: 'user',
    status: 'completed',
    text: 'hello',
    createdAt: 0,
  },
})

afterAll(() => store.close())

describe('long-thread submission deduplication', () => {
  bench(
    'scans JSON across 100,000 events for one item id',
    () => {
      if (!store.hasItem('thread-1', 'submission-1')) throw new Error('missing item')
    },
    OPTIONS,
  )

  bench(
    'reads one indexed user submission id',
    () => {
      if (!store.hasUserSubmission('thread-1', 'submission-1')) {
        throw new Error('missing submission')
      }
    },
    OPTIONS,
  )
})
