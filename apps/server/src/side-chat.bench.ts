import { bench, describe } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { projectHistoryItems, snapshotCompactReplayEntries, snapshotEntries } from './side-chat.js'

type SnapshotEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'activity'
      type: Exclude<Item['type'], 'message' | 'reasoning'>
      status: Item['status']
    }

const OPTIONS = { time: 1_200, warmupTime: 300 }
const MAX_SNAPSHOT_ENTRIES = 80
const MAX_SNAPSHOT_CHARACTERS = 64_000
const MAX_ENTRY_CHARACTERS = 24_000
const history: Array<{ event: DomainEvent }> = [
  completedMessage('user', 'user', 'Original request'),
  ...Array.from({ length: 10_000 }, (_, index) =>
    completedMessage(`assistant-${index}`, 'assistant', `Update ${index} ${'x'.repeat(2_000)}`),
  ),
].map((event) => ({ event }))

function legacyProjectFinalItems(history: ReadonlyArray<{ event: DomainEvent }>): Item[] {
  const order: string[] = []
  const items = new Map<string, Item>()
  for (const { event } of history) {
    if (event.type !== 'item.started' && event.type !== 'item.completed') continue
    if (!items.has(event.item.id)) order.push(event.item.id)
    items.set(event.item.id, event.item)
  }
  return order.map((id) => items.get(id)).filter((item): item is Item => item !== undefined)
}

function completedMessage(id: string, role: 'user' | 'assistant', text: string): DomainEvent {
  return {
    type: 'item.completed',
    item: {
      id,
      turnId: id,
      type: 'message',
      role,
      status: 'completed',
      text,
      createdAt: 1,
    },
  }
}

function legacySnapshotEntries(history: ReadonlyArray<{ event: DomainEvent }>): SnapshotEntry[] {
  const visible = projectHistoryItems(history)
    .filter((item) => item.type !== 'reasoning')
    .map(toSnapshotEntry)
    .filter((entry): entry is SnapshotEntry => entry !== undefined)

  const bounded: SnapshotEntry[] = []
  let characters = 0
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const entry = visible[index]!
    const length = JSON.stringify(entry).length
    if (bounded.length >= MAX_SNAPSHOT_ENTRIES || characters + length > MAX_SNAPSHOT_CHARACTERS) {
      break
    }
    bounded.unshift(entry)
    characters += length
  }
  if (!bounded.some((entry) => entry.kind === 'message' && entry.role === 'user')) {
    const latestUser = visible.findLast(
      (entry): entry is Extract<SnapshotEntry, { kind: 'message' }> =>
        entry.kind === 'message' && entry.role === 'user',
    )
    if (latestUser) {
      const length = JSON.stringify(latestUser).length
      while (bounded.length > 0 && characters + length > MAX_SNAPSHOT_CHARACTERS) {
        characters -= JSON.stringify(bounded.shift()).length
      }
      bounded.unshift(latestUser)
    }
  }
  return bounded
}

function toSnapshotEntry(item: Item): SnapshotEntry | undefined {
  if (item.type === 'message') {
    const text = item.text?.trim()
    if (!item.role || !text) return undefined
    return { kind: 'message', role: item.role, text: boundedText(text) }
  }
  if (item.type === 'reasoning') return undefined
  return { kind: 'activity', type: item.type, status: item.status }
}

function boundedText(text: string): string {
  return text.length <= MAX_ENTRY_CHARACTERS
    ? text
    : `[earlier content truncated]\n${text.slice(-MAX_ENTRY_CHARACTERS)}`
}

describe('many-entry side chat snapshot', () => {
  bench(
    'materializes all 10,001 visible entries before bounding',
    () => {
      if (legacySnapshotEntries(history).length === 0) throw new Error('missing legacy snapshot')
    },
    OPTIONS,
  )

  bench(
    'materializes only the bounded visible tail',
    () => {
      if (snapshotEntries(history).length === 0) throw new Error('missing snapshot')
    },
    OPTIONS,
  )

  bench(
    'scans the compact replay without materializing old items',
    () => {
      if (snapshotCompactReplayEntries(history).length === 0) {
        throw new Error('missing compact replay snapshot')
      }
    },
    OPTIONS,
  )
})

describe('already-final history projection', () => {
  bench(
    'projects 10,001 final items through an order map',
    () => {
      if (legacyProjectFinalItems(history).length !== history.length) {
        throw new Error('missing legacy items')
      }
    },
    OPTIONS,
  )

  bench(
    'projects 10,001 final items directly',
    () => {
      if (projectHistoryItems(history).length !== history.length) throw new Error('missing items')
    },
    OPTIONS,
  )
})
