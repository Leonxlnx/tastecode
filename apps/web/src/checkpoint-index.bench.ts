import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import { checkpointForItem, createCheckpointIndex } from './checkpoint-index.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const checkpoints = Array.from({ length: 10_000 }, (_, index) => ({
  id: index,
  label: 'Repeated prompt',
  createdAt: index,
}))
const prompt: Item = {
  id: 'prompt',
  turnId: 'turn',
  type: 'message',
  role: 'user',
  status: 'completed',
  text: 'Repeated prompt',
  createdAt: 1,
}
const index = createCheckpointIndex(checkpoints)

describe('long-thread checkpoint lookup', () => {
  bench(
    'linear reverse scan',
    () => {
      if (
        !checkpoints.findLast(
          (checkpoint) =>
            checkpoint.label === prompt.text && checkpoint.createdAt <= prompt.createdAt,
        )
      ) {
        throw new Error('checkpoint missing')
      }
    },
    OPTIONS,
  )

  bench(
    'indexed binary lookup',
    () => {
      if (!checkpointForItem(prompt, index)) throw new Error('checkpoint missing')
    },
    OPTIONS,
  )
})
