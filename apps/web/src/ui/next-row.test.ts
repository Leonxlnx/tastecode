import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import type { LiveItemUpdate } from '../thread-store.js'
import { nextItemWithARow } from './next-row.js'

const NONE: ReadonlyMap<number, LiveItemUpdate> = new Map()

/** A run of blank reasoning after one row, each counting how often its kind is read. */
function transcript(blank: number) {
  let reads = 0
  const row = (id: string, type: Item['type'], text: string): Item => {
    const item = { id, turnId: 'turn', status: 'completed', text, createdAt: 0 } as Item
    Object.defineProperty(item, 'type', {
      enumerable: true,
      get: () => {
        reads += 1
        return type
      },
    })
    return item
  }
  const items: Item[] = [row('tool', 'tool_call', 'Ran tests')]
  for (let index = 0; index < blank; index += 1) items.push(row(`r${index}`, 'reasoning', ''))
  items.push(row('answer', 'message', 'Done'))
  return { items, reads: () => reads }
}

describe('next row lookup', () => {
  it('finds the row after blank reasoning, and the end when there is none', () => {
    const { items } = transcript(3)
    expect(nextItemWithARow(items, NONE, 1)?.id).toBe('answer')
    expect(nextItemWithARow(items, NONE, 4)?.id).toBe('answer')
    expect(nextItemWithARow(items.slice(0, 4), NONE, 1)).toBeUndefined()
  })

  it('walks a run of blank reasoning once per transcript, not on every row render', () => {
    const { items, reads } = transcript(2_000)
    expect(nextItemWithARow(items, NONE, 1)?.id).toBe('answer')
    const first = reads()
    expect(first).toBeGreaterThanOrEqual(2_000)
    // A streaming row renders again and again against the same structural items.
    for (let render = 0; render < 100; render += 1) {
      expect(nextItemWithARow(items, NONE, 1)?.id).toBe('answer')
    }
    expect(reads() - first).toBeLessThanOrEqual(100)
  })

  it('reads a live update that falls inside the walk instead of the cached answer', () => {
    const { items } = transcript(3)
    expect(nextItemWithARow(items, NONE, 1)?.id).toBe('answer')
    const thought: Item = {
      id: 'r1',
      turnId: 'turn',
      type: 'reasoning',
      status: 'started',
      text: 'Thinking',
      createdAt: 0,
    }
    const live = new Map([[2, { item: thought } as LiveItemUpdate]])
    expect(nextItemWithARow(items, live, 1)?.id).toBe('r1')
  })

  it('answers again for a new transcript array', () => {
    const { items } = transcript(3)
    expect(nextItemWithARow(items, NONE, 1)?.id).toBe('answer')
    const next = [...items]
    next[2] = { ...items[2]!, type: 'reasoning', text: 'Now visible' }
    expect(nextItemWithARow(next, NONE, 1)?.id).toBe('r1')
  })
})
