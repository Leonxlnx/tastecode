import type { ItemDeltaEvent, ThreadState } from './thread-store.js'
import { emptyThread, reduceDeltas } from './thread-store.js'

export const BACKGROUND_DELTA_EVENT_LIMIT = 256
export const BACKGROUND_DELTA_TEXT_LIMIT = 64 * 1024

export type PendingThreadDeltaBatch = {
  events: ItemDeltaEvent[]
  /** Original event count when adjacent hidden deltas have been coalesced. */
  eventCount?: number
  /** Retained row count after the last hidden append. */
  backgroundEventLength?: number
  textLength: number
  sequence?: number
  /** True only when the current tail is a batch-owned clone. */
  tailIsOwned?: boolean
}

/** Partial background caches reload from SQLite, so retaining their transcript deltas is waste. */
export function shouldRetainThreadTranscript(
  threadId: string,
  activeThreadId: string | undefined,
  partialThreadIds: ReadonlySet<string>,
): boolean {
  return threadId === activeThreadId || !partialThreadIds.has(threadId)
}

export function appendThreadDelta(
  batch: PendingThreadDeltaBatch | undefined,
  event: ItemDeltaEvent,
  sequence?: number,
): PendingThreadDeltaBatch {
  if (!batch) {
    return {
      events: [event],
      textLength: event.textDelta.length,
      ...(sequence === undefined ? {} : { sequence }),
    }
  }

  batch.events.push(event)
  batch.textLength += event.textDelta.length
  if (sequence !== undefined) batch.sequence = Math.max(batch.sequence ?? sequence, sequence)
  return batch
}

/** Hidden transcripts do not paint each fragment, so retain one adjacent delta per item. */
export function appendBackgroundThreadDelta(
  batch: PendingThreadDeltaBatch | undefined,
  event: ItemDeltaEvent,
  sequence?: number,
): PendingThreadDeltaBatch {
  if (!batch) {
    return {
      events: [event],
      eventCount: 1,
      backgroundEventLength: 1,
      textLength: event.textDelta.length,
      ...(sequence === undefined ? {} : { sequence }),
    }
  }

  const uncountedEvents =
    batch.eventCount === undefined
      ? batch.events.length
      : batch.events.length - (batch.backgroundEventLength ?? batch.events.length)
  const eventCount = (batch.eventCount ?? 0) + uncountedEvents
  const tailWasAppendedWhileActive =
    batch.backgroundEventLength !== undefined && batch.events.length > batch.backgroundEventLength
  const tailIndex = batch.events.length - 1
  const tail = batch.events[tailIndex]
  if (tail?.turnId === event.turnId && tail.itemId === event.itemId) {
    if (batch.tailIsOwned && !tailWasAppendedWhileActive) tail.textDelta += event.textDelta
    else {
      batch.events[tailIndex] = { ...tail, textDelta: tail.textDelta + event.textDelta }
      batch.tailIsOwned = true
    }
  } else {
    batch.events.push(event)
    batch.tailIsOwned = false
  }
  batch.eventCount = eventCount + 1
  batch.backgroundEventLength = batch.events.length
  batch.textLength += event.textDelta.length
  if (sequence !== undefined) batch.sequence = Math.max(batch.sequence ?? sequence, sequence)
  return batch
}

export function shouldDrainBackgroundDeltas(batch: PendingThreadDeltaBatch): boolean {
  return (
    (batch.eventCount ?? batch.events.length) >= BACKGROUND_DELTA_EVENT_LIMIT ||
    batch.textLength >= BACKGROUND_DELTA_TEXT_LIMIT
  )
}

export function drainPendingThreadDeltas(
  threadStates: Map<string, ThreadState>,
  pendingDeltas: Map<string, PendingThreadDeltaBatch>,
  durableSequences: Map<string, number>,
  threadId: string,
): ThreadState {
  const batch = pendingDeltas.get(threadId)
  const current = threadStates.get(threadId) ?? emptyThread
  if (!batch || batch.events.length === 0) return current

  pendingDeltas.delete(threadId)
  const next = reduceDeltas(current, batch.events)
  threadStates.set(threadId, next)
  if (batch.sequence !== undefined && durableSequences.has(threadId)) {
    durableSequences.set(threadId, Math.max(durableSequences.get(threadId) ?? 0, batch.sequence))
  }
  return next
}
