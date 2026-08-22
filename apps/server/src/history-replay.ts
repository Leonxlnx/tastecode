import type { DomainEvent, Item } from '@harness/contracts'
import { projectHistoryItems } from './side-chat.js'

type HistoryEntry = { seq: number; event: DomainEvent }

const replayStateEvents = new Set<DomainEvent['type']>([
  'diff.updated',
  'plan.updated',
  'usage.updated',
])

/**
 * Removes superseded streaming and presentation events from a fresh replay.
 * The durable log stays untouched, and incremental reads still return every
 * event; only the state snapshot sent when opening a thread is compacted.
 */
export function compactHistoryReplay(entries: readonly HistoryEntry[]): HistoryEntry[] {
  if (entries.length === 0) return []
  if (!needsHistoryCompaction(entries)) return entries.slice()

  const finalItems = new Map(projectHistoryItems(entries).map((item) => [item.id, item]))
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
    // A delta before an item boundary is legal recovery input, but its
    // synthesized timestamp is renderer-owned. Keep that rare sequence exact.
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

function needsHistoryCompaction(entries: readonly HistoryEntry[]): boolean {
  const itemIds = new Set<string>()
  let hasUsage = false
  let hasDiff = false
  let hasPlan = false

  for (const { event } of entries) {
    if (event.type === 'turn.started') {
      hasDiff = false
      hasPlan = false
    } else if (event.type === 'usage.updated') {
      if (hasUsage) return true
      hasUsage = true
    } else if (event.type === 'diff.updated') {
      if (hasDiff) return true
      hasDiff = true
    } else if (event.type === 'plan.updated') {
      if (hasPlan) return true
      hasPlan = true
    }

    const itemId = historyItemId(event)
    if (itemId === undefined) continue
    if (itemIds.has(itemId)) return true
    itemIds.add(itemId)
  }
  return false
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
