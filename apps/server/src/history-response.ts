import type { DomainEvent, ResultOf } from '@harness/contracts'

type HistoryEntry = { seq: number; event: DomainEvent }
type HistoryResult = ResultOf<'thread.history'>

/** Retain the response wrapper while a parsed immutable replay remains current. */
export function createHistoryResponseProjector() {
  const idle = new WeakMap<HistoryEntry[], HistoryResult>()
  const running = new WeakMap<HistoryEntry[], HistoryResult>()
  return (events: HistoryEntry[], isRunning: boolean): HistoryResult => {
    const cache = isRunning ? running : idle
    const cached = cache.get(events)
    if (cached) return cached
    const result = { events, running: isRunning }
    cache.set(events, result)
    return result
  }
}
