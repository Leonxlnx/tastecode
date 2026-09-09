import { bench, describe } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { compactHistoryReplay } from './history-replay.js'

type HistoryEntry = { seq: number; event: DomainEvent }

const OPTIONS = { time: 1_200, warmupTime: 300 }
const replayStateEvents = new Set<DomainEvent['type']>([
  'diff.updated',
  'plan.updated',
  'usage.updated',
])

const settledHistory: HistoryEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
  seq: index + 1,
  event: {
    type: 'item.completed',
    item: {
      id: `item-${index}`,
      turnId: `turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: 'done',
      createdAt: index,
    },
  },
}))

function legacyCompactHistoryReplay(entries: readonly HistoryEntry[]): HistoryEntry[] {
  if (entries.length === 0) return []

  const finalItems = new Map(legacyProjectHistoryItems(entries).map((item) => [item.id, item]))
  const firstItemEvent = new Map<string, { index: number; type: DomainEvent['type'] }>()
  let lastUsage = -1
  let lastDiff = -1
  let lastPlan = -1

  for (let index = 0; index < entries.length; index += 1) {
    const event = entries[index]!.event
    if (event.type === 'turn.started') {
      lastDiff = -1
      lastPlan = -1
    } else if (event.type === 'usage.updated') lastUsage = index
    else if (event.type === 'diff.updated') lastDiff = index
    else if (event.type === 'plan.updated') lastPlan = index

    const itemId = historyItemId(event)
    if (itemId !== undefined && !firstItemEvent.has(itemId)) {
      firstItemEvent.set(itemId, { index, type: event.type })
    }
  }

  const retainedState = new Set([lastUsage, lastDiff, lastPlan])
  const compacted: HistoryEntry[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (replayStateEvents.has(entry.event.type) && !retainedState.has(index)) continue

    const itemId = historyItemId(entry.event)
    if (itemId === undefined) {
      compacted.push(entry)
      continue
    }

    const first = firstItemEvent.get(itemId)
    if (!first || first.type === 'item.delta') {
      compacted.push(entry)
      continue
    }
    if (index !== first.index) continue

    const item = finalItems.get(itemId)
    compacted.push(item ? { ...entry, event: finalItemEvent(item) } : entry)
  }
  return compacted
}

function legacyProjectHistoryItems(history: readonly HistoryEntry[]): Item[] {
  const order: string[] = []
  const items = new Map<string, Item>()
  for (const { event } of history) {
    if (event.type !== 'item.started' && event.type !== 'item.completed') continue
    if (!items.has(event.item.id)) order.push(event.item.id)
    items.set(event.item.id, event.item)
  }
  return order.map((id) => items.get(id)).filter((item): item is Item => item !== undefined)
}

function historyItemId(event: DomainEvent): string | undefined {
  if (event.type === 'item.started' || event.type === 'item.completed') return event.item.id
  if (event.type === 'item.delta') return event.itemId
  return undefined
}

function finalItemEvent(item: Item): DomainEvent {
  return item.status === 'started'
    ? { type: 'item.started', item }
    : { type: 'item.completed', item }
}

describe('settled history replay compaction', () => {
  bench(
    'projects and rebuilds 1,000 final items',
    () => {
      if (legacyCompactHistoryReplay(settledHistory).length !== settledHistory.length) {
        throw new Error('invalid legacy replay')
      }
    },
    OPTIONS,
  )

  bench(
    'returns 1,000 already-final items after one scan',
    () => {
      if (compactHistoryReplay(settledHistory).length !== settledHistory.length) {
        throw new Error('invalid compact replay')
      }
    },
    OPTIONS,
  )
})
