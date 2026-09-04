import type { DomainEvent } from '@harness/contracts'

const DEFAULT_DELAY_MS = 4
const DEFAULT_MAXIMUM_TEXT_LENGTH = 64 * 1024
const DEFAULT_MAXIMUM_EVENT_COUNT = 256

export type ItemDeltaEvent = Extract<DomainEvent, { type: 'item.delta' }>
export type RecordedDelta = { threadId: string; event: ItemDeltaEvent }

type RecordedDeltaBufferOptions = {
  delayMs?: number
  maximumTextLength?: number
  maximumEventCount?: number
  commitBatch?: (records: RecordedDelta[]) => void
}

type PendingDelta = {
  turnId: string
  itemId: string
  text: string
  eventCount: number
}

/**
 * Coalesce adjacent provider text deltas before they reach SQLite and the
 * WebSocket. The renderer already paints at frame cadence, so persisting and
 * sending every provider fragment only adds work and makes histories larger.
 */
export class RecordedDeltaBuffer {
  #pending = new Map<string, PendingDelta>()
  #timer: ReturnType<typeof setTimeout> | undefined
  readonly #delayMs: number
  readonly #maximumTextLength: number
  readonly #maximumEventCount: number
  readonly #commitBatch: (records: RecordedDelta[]) => void

  constructor(
    private readonly commit: (threadId: string, event: ItemDeltaEvent) => void,
    options: RecordedDeltaBufferOptions = {},
  ) {
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS
    this.#maximumTextLength = options.maximumTextLength ?? DEFAULT_MAXIMUM_TEXT_LENGTH
    this.#maximumEventCount = options.maximumEventCount ?? DEFAULT_MAXIMUM_EVENT_COUNT
    this.#commitBatch =
      options.commitBatch ??
      ((records) => records.forEach(({ threadId, event }) => commit(threadId, event)))
  }

  push(threadId: string, event: ItemDeltaEvent): void {
    let pending = this.#pending.get(threadId)
    if (pending && (pending.turnId !== event.turnId || pending.itemId !== event.itemId)) {
      this.flush(threadId)
      pending = undefined
    }

    if (!pending) {
      pending = {
        turnId: event.turnId,
        itemId: event.itemId,
        text: event.textDelta,
        eventCount: 1,
      }
      this.#pending.set(threadId, pending)
      this.#schedule()
    } else {
      pending.text += event.textDelta
      pending.eventCount += 1
    }

    if (
      pending.text.length >= this.#maximumTextLength ||
      pending.eventCount >= this.#maximumEventCount
    ) {
      this.flush(threadId)
    }
  }

  flush(threadId: string): void {
    const pending = this.#pending.get(threadId)
    if (!pending) return
    this.#pending.delete(threadId)
    if (this.#pending.size === 0) this.#clearTimer()
    this.#commit(threadId, pending)
  }

  flushAll(): void {
    this.#clearTimer()
    const pending = this.#pending
    this.#pending = new Map()
    this.#commitPending(pending)
  }

  discard(threadId: string): void {
    if (!this.#pending.delete(threadId)) return
    if (this.#pending.size === 0) this.#clearTimer()
  }

  discardAll(): void {
    this.#pending.clear()
    this.#clearTimer()
  }

  #schedule(): void {
    this.#timer ??= setTimeout(() => this.#flushWindow(), this.#delayMs)
  }

  #flushWindow(): void {
    this.#timer = undefined
    const pending = this.#pending
    this.#pending = new Map()
    this.#commitPending(pending)
  }

  #commit(threadId: string, pending: PendingDelta): void {
    this.commit(threadId, {
      type: 'item.delta',
      turnId: pending.turnId,
      itemId: pending.itemId,
      textDelta: pending.text,
    })
  }

  #commitPending(pending: ReadonlyMap<string, PendingDelta>): void {
    if (pending.size === 0) return
    if (pending.size === 1) {
      const entry = pending.entries().next().value
      if (entry) this.#commit(entry[0], entry[1])
      return
    }
    const records: RecordedDelta[] = []
    for (const [threadId, delta] of pending) {
      records.push({
        threadId,
        event: {
          type: 'item.delta',
          turnId: delta.turnId,
          itemId: delta.itemId,
          textDelta: delta.text,
        },
      })
    }
    this.#commitBatch(records)
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
