import { describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  emptyThread,
  reduceDeltas,
  type LiveItemUpdate,
  type ThreadState,
} from '../thread-store.js'
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

  it('keeps interleaved streaming bounded against a large live overlay', () => {
    // 70 streamed rows, a visible thought A, 2,000 blank thoughts, an answer B
    // and a later row C. A and C stream in turn; the overlay holds every row.
    let reads = 0
    const counted = (item: Item): Item => {
      const { type } = item
      Object.defineProperty(item, 'type', {
        enumerable: true,
        get: () => {
          reads += 1
          return type
        },
      })
      return item
    }
    const row = (id: string, type: Item['type'], text: string): Item =>
      counted({ id, turnId: 'turn', type, status: 'started', text, createdAt: 0 } as Item)
    const items: Item[] = []
    for (let index = 0; index < 70; index += 1) items.push(row(`m${index}`, 'message', ''))
    const thought = items.push(row('A', 'reasoning', 'Thinking')) - 1
    for (let index = 0; index < 2_000; index += 1) items.push(row(`r${index}`, 'reasoning', ''))
    items.push({ ...row('B', 'message', 'Done'), status: 'completed' })
    items.push(row('C', 'message', ''))
    let state: ThreadState = {
      ...emptyThread,
      items,
      running: true,
      activeTurn: { id: 'turn', startedAt: 0 },
    }
    const delta = (itemId: string, textDelta: string) => {
      state = reduceDeltas(state, [{ type: 'item.delta', turnId: 'turn', itemId, textDelta }])
    }
    for (let index = 0; index < 70; index += 1) delta(`m${index}`, 'x')
    delta('C', 'x')
    delta('A', '.')
    const overlay = Object.getPrototypeOf(state.liveItems) as { materialize: () => unknown }
    expect(overlay.constructor.name).toBe('LiveItemOverlay')
    const materialize = vi.spyOn(overlay, 'materialize')
    let lookups = 0
    const lookup = () => {
      const before = materialize.mock.calls.length
      const found = nextItemWithARow(state.items, state.liveItems, thought + 1)
      lookups += materialize.mock.calls.length - before
      return found
    }

    expect(lookup()?.id).toBe('B')
    const warm = reads
    for (let frame = 0; frame < 200; frame += 1) {
      delta('C', 'y')
      expect(lookup()?.id).toBe('B')
      delta('A', '.')
      expect(lookup()?.id).toBe('B')
    }
    expect(lookups).toBe(0)
    // One read of the immediate next row per lookup, nothing of the run behind it.
    expect(reads - warm).toBeLessThanOrEqual(400)

    // A delta inside the run shows its row; an earlier one then takes over.
    delta('r5', 'Plan')
    expect(lookup()?.id).toBe('r5')
    delta('r2', 'Check')
    expect(lookup()?.id).toBe('r2')
    delta('C', 'z')
    expect(lookup()?.id).toBe('r2')
    expect(lookups).toBe(0)
    materialize.mockRestore()
  })

  it('answers again for a new transcript array', () => {
    const { items } = transcript(3)
    expect(nextItemWithARow(items, NONE, 1)?.id).toBe('answer')
    const next = [...items]
    next[2] = { ...items[2]!, type: 'reasoning', text: 'Now visible' }
    expect(nextItemWithARow(next, NONE, 1)?.id).toBe('r1')
  })
})
