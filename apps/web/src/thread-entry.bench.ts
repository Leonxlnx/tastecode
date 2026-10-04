import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import { enteringThreadItems } from './thread-entry.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const history: Item[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `history-${index}`,
  turnId: `turn-${index}`,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  text: 'done',
  createdAt: index,
}))

describe('long-thread initial entry classification', () => {
  bench(
    'copies the full history before suppressing entry animation',
    () => {
      const appended = history.slice(0)
      const incoming = appended.length > 1 ? [] : appended
      if (incoming.length !== 0) throw new Error('invalid legacy entries')
    },
    OPTIONS,
  )

  bench(
    'suppresses bulk history before reading its rows',
    () => {
      if (enteringThreadItems([], history).length !== 0) throw new Error('invalid entries')
    },
    OPTIONS,
  )
})
