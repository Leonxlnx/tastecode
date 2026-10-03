import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { checkpointForItem, createCheckpointIndex } from './checkpoint-index.js'

const prompt = (id: string, createdAt: number, text = 'Fix the parser'): Item => ({
  id: `local:${id}`,
  turnId: id,
  type: 'message',
  role: 'user',
  status: 'completed',
  text,
  createdAt,
})

describe('checkpoint index', () => {
  it('matches the first prompt to its later snapshot, not a preceding checkpoint', () => {
    const first = prompt('first', 10)
    const index = createCheckpointIndex([{ id: 1, label: 'Fix the parser', createdAt: 15 }])
    expect(checkpointForItem(first, index, [first])?.id).toBe(1)
  })

  it('matches repeated prompts to distinct subsequent snapshots', () => {
    const items = [prompt('first', 10), prompt('second', 30), prompt('third', 50)]
    const index = createCheckpointIndex([
      { id: 3, label: 'Fix the parser', createdAt: 55 },
      { id: 1, label: 'Fix the parser', createdAt: 15 },
      { id: 2, label: 'Fix the parser', createdAt: 35 },
    ])
    expect(items.map((item) => checkpointForItem(item, index, items)?.id)).toEqual([1, 2, 3])
  })

  it('handles equal timestamps and shared 60-character labels', () => {
    const label = 'x'.repeat(60)
    const items = [prompt('first', 10, `${label} first`), prompt('second', 30, `${label} second`)]
    const index = createCheckpointIndex([
      { id: 1, label, createdAt: 10 },
      { id: 2, label, createdAt: 35 },
    ])
    expect(items.map((item) => checkpointForItem(item, index, items)?.id)).toEqual([1, 2])
  })

  it('does not guess when queued prompts share a possible snapshot', () => {
    const items = [prompt('first', 10), prompt('second', 11)]
    const index = createCheckpointIndex([
      { id: 1, label: 'Fix the parser', createdAt: 20 },
      { id: 2, label: 'Fix the parser', createdAt: 40 },
    ])
    expect(items.map((item) => checkpointForItem(item, index, items))).toEqual([
      undefined,
      undefined,
    ])
  })

  it('does not reuse an older checkpoint for a prompt without a subsequent snapshot', () => {
    const item = prompt('first', 20)
    const index = createCheckpointIndex([{ id: 1, label: 'Fix the parser', createdAt: 10 }])
    expect(checkpointForItem(item, index, [item])).toBeUndefined()
  })

  it('does not align incomplete pages or imported history by position', () => {
    const items = [prompt('second', 30)]
    const index = createCheckpointIndex([
      { id: 1, label: 'Fix the parser', createdAt: 15 },
      { id: 2, label: 'Fix the parser', createdAt: 35 },
    ])
    expect(checkpointForItem(items[0]!, index, items)).toBeUndefined()
    const imported = { ...prompt('imported', 10), id: 'provider-message' }
    expect(checkpointForItem(imported, index, [imported])).toBeUndefined()
  })

  it('does not associate steered prompts with another turn checkpoint', () => {
    const first = prompt('first', 10)
    const steered = { ...prompt('steered', 11), turnId: first.turnId }
    const index = createCheckpointIndex([{ id: 1, label: 'Fix the parser', createdAt: 15 }])
    expect(checkpointForItem(first, index, [first, steered])?.id).toBe(1)
    expect(checkpointForItem(steered, index, [first, steered])).toBeUndefined()
  })

  it('ignores non-user items and indexes a transcript only once', () => {
    let reads = 0
    const first = prompt('first', 10)
    const index = createCheckpointIndex([{ id: 1, label: 'Fix the parser', createdAt: 15 }])
    const items = new Proxy([first], {
      get(target, key, receiver) {
        if (key === '0') reads += 1
        return Reflect.get(target, key, receiver)
      },
    })
    expect(checkpointForItem(first, index, items)?.id).toBe(1)
    const initial = reads
    expect(checkpointForItem(first, index, items)?.id).toBe(1)
    expect(reads).toBe(initial)
    expect(checkpointForItem({ ...first, role: 'assistant' }, index, items)).toBeUndefined()
  })
})
