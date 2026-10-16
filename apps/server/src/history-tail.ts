import type { DomainEvent } from '@harness/contracts'
import {
  DEFAULT_HISTORY_PAGE_TURNS,
  historyTurnKey,
  readNewestHistoryPageFromTail,
  type HistoryCarry,
  type HistoryPage,
} from './history-page.js'
import { compactHistoryReplay, historyItemId, needsHistoryCompaction } from './history-replay.js'

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

const FIRST_READ_ROWS = 512
const MAX_READ_ROWS = 8_192

/**
 * The newest history page read from the end of the event log, without
 * parsing the rows before it. Returns undefined when the index cannot vouch
 * for the result; the caller then compacts the whole log as before.
 *
 * The page equals `readHistoryPage(compactHistoryReplay(all rows))`. Reading
 * newest first, the tail grows until no turn or item in it also occurs in an
 * older row (the index stores each key's first row). Compacting such a tail
 * alone gives the same events as compacting the whole log, and the blocks
 * after its first one are the whole log's blocks. What older rows still hold
 * open (usage, approvals, questions) comes from the index's state rows.
 */
export function readIndexedNewestHistoryPage(
  source: HistoryTailSource,
  threadId: string,
  turnLimit: number | undefined,
  firstReadRows = FIRST_READ_ROWS,
): HistoryPage | undefined {
  // Imported provider turns display in time order, not log order.
  if (!source.historyIndexed(threadId) || source.historyHasImportedTurns(threadId)) return undefined
  const limit = Math.max(1, turnLimit ?? DEFAULT_HISTORY_PAGE_TURNS)
  let tail: HistoryEntry[] = []
  let oldestSeq = Number.MAX_SAFE_INTEGER
  let firstNamed = Number.MAX_SAFE_INTEGER
  let rows = firstReadRows
  for (;;) {
    // A read that cut through a turn or item first reads back to the row that
    // names it; only a closed tail grows by whole chunks.
    const closing = firstNamed < oldestSeq
    const read = source.historyRowsBefore(
      threadId,
      oldestSeq,
      closing ? { fromSeq: firstNamed } : { limit: rows },
    )
    // The whole log fits in what was read. Compacting it as before also saves
    // the replay that older pages are cut from.
    if (read.complete) return undefined
    tail = read.entries.concat(tail)
    if (closing) oldestSeq = firstNamed
    else {
      oldestSeq = read.oldestSeq!
      rows = Math.min(rows * 2, MAX_READ_ROWS)
    }

    const keys = new Set<string>()
    for (const { event } of read.entries) {
      for (const key of historyIndexKeys(event)) keys.add(key)
      // Thread errors project as `thread-error:<n>` items; a real item with
      // such an id would depend on how many items came before the tail.
      if (historyItemId(event)?.startsWith('thread-error:')) return undefined
    }
    const firstSeqs = source.historyKeyFirstSeqs(threadId, [...keys])
    for (const key of keys) {
      const first = firstSeqs.get(key)
      // A key the index never saw was written around it: trust nothing.
      if (first === undefined) return undefined
      firstNamed = Math.min(firstNamed, first)
    }
    if (firstNamed < oldestSeq) continue
    // Compaction keeps a log it would not change; a tail that would not
    // change cannot tell whether the rows before it would.
    if (!needsHistoryCompaction(tail)) continue

    const page = readNewestHistoryPageFromTail(threadId, compactHistoryReplay(tail), limit, () =>
      source.historyCarryBefore(threadId, oldestSeq),
    )
    if (page) return page
  }
}
