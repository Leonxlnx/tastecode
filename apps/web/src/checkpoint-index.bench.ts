import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import { checkpointForItem, createCheckpointIndex } from './checkpoint-index.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const checkpoints = Array.from({ length: 10_000 }, (_, index) => ({
  id: index,
  label: 'Repeated prompt',
  createdAt: index * 10 + 5,
}))
const prompt: Item = {
  id: 'local:prompt',
  turnId: 'turn',
  type: 'message',
  role: 'user',
  status: 'completed',
  text: 'Repeated prompt',
  createdAt: 1,
}
const index = createCheckpointIndex(checkpoints)
const items = checkpoints.map((checkpoint) => ({
  ...prompt,
  id: `local:${checkpoint.id}`,
  turnId: `turn-${checkpoint.id}`,
  createdAt: checkpoint.createdAt - 5,
}))
const target = items[9_999]!
checkpointForItem(target, index, items)

describe('long-thread checkpoint lookup', () => {
  bench(
    'linear subsequent snapshot scan',
    () => {
      if (
        !checkpoints.find(
          (checkpoint) =>
            checkpoint.label === target.text && checkpoint.createdAt >= target.createdAt,
        )
      ) {
        throw new Error('checkpoint missing')
      }
    },
    OPTIONS,
  )

  bench(
    'cached transcript association',
    () => {
      if (!checkpointForItem(target, index, items)) throw new Error('checkpoint missing')
    },
    OPTIONS,
  )
})
