import type { DomainEvent } from '@harness/contracts'
import { historyTurnKey, type HistoryCarry } from './history-page.js'
import { historyItemId } from './history-replay.js'

type HistoryEntry = { seq: number; event: DomainEvent }

/** The rows a newest page carries state from, besides the rows inside it. */
export const HISTORY_STATE_EVENT_TYPES: ReadonlySet<DomainEvent['type']> = new Set([
  'usage.updated',
  'approval.requested',
  'approval.resolved',
  'user_input.requested',
  'user_input.resolved',
  'turn.completed',
  'thread.error',
])

/** The turn and item an event names, as the history index stores them. */
export function historyIndexKeys(event: DomainEvent): string[] {
  const keys: string[] = []
  const turn = historyTurnKey(event)
  if (turn !== undefined) keys.push(`t:${turn}`)
  const item = historyItemId(event)
  if (item !== undefined) keys.push(`i:${item}`)
  return keys
}

/** One read of the log's end: oldest row first, and whether no older row exists. */
export type HistoryTailRows = {
  entries: HistoryEntry[]
  /** The lowest sequence read, readable or not. */
  oldestSeq: number | undefined
  complete: boolean
}

/** The store's history index, as the bounded reader uses it. */
export type HistoryTailSource = {
  historyIndexed(threadId: string): boolean
  historyHasImportedTurns(threadId: string): boolean
  /**
   * Readable active rows before `beforeSeq`, oldest first, like `Store.history`:
   * the newest `limit` of them (`complete` when fewer exist), or all from `fromSeq` on.
   */
  historyRowsBefore(
    threadId: string,
    beforeSeq: number,
    range: { limit: number } | { fromSeq: number },
  ): HistoryTailRows
  historyKeyFirstSeqs(threadId: string, keys: readonly string[]): Map<string, number>
  historyCarryBefore(threadId: string, seq: number): HistoryCarry
}
