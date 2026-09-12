import type { ApprovalMode, DomainEvent, ResultOf } from '@harness/contracts'

type HistoryEntry = { seq: number; event: DomainEvent }
type HistoryResult = ResultOf<'thread.history'>

/** Retain the response wrapper while a parsed immutable replay remains current. */
export function createHistoryResponseProjector() {
  const cache = new WeakMap<HistoryEntry[], Map<string, HistoryResult>>()
  return (events: HistoryEntry[], isRunning: boolean, approval: ApprovalMode): HistoryResult => {
    const key = `${String(isRunning)}:${approval}`
    const byState = cache.get(events)
    const cached = byState?.get(key)
    if (cached) return cached
    const result = { events, running: isRunning, approval }
    if (byState) byState.set(key, result)
    else cache.set(events, new Map([[key, result]]))
    return result
  }
}
