import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { checkpointForItem, createCheckpointIndex } from './checkpoint-index.js'

const prompt: Item = {
  id: 'prompt',
  turnId: 'turn',
  type: 'message',
  role: 'user',
  status: 'completed',
  text: 'Fix the parser',
  createdAt: 20,
}

describe('checkpoint index', () => {
  it('finds the latest matching checkpoint that is not newer than the prompt', () => {
    const checkpoints = [
      { id: 3, label: 'Fix the parser', createdAt: 30 },
      { id: 1, label: 'Fix the parser', createdAt: 10 },
      { id: 2, label: 'Fix the parser', createdAt: 20 },
      { id: 4, label: 'Different prompt', createdAt: 20 },
    ]

    expect(checkpointForItem(prompt, createCheckpointIndex(checkpoints))?.id).toBe(2)
  })

  it('ignores non-user items and missing labels', () => {
    const checkpoints = createCheckpointIndex([{ id: 1, label: 'Other', createdAt: 10 }])

    expect(checkpointForItem(prompt, checkpoints)).toBeUndefined()
    expect(checkpointForItem({ ...prompt, role: 'assistant' }, checkpoints)).toBeUndefined()
  })
})
