const BLOCKED_RETRY_MS = 30_000
const MAX_TIMEOUT_MS = 2_147_000_000

/**
 * Sleeps until the next persisted lifecycle deadline.
 *
 * A due thread that cannot be hidden yet is checked at the old 30 second
 * cadence. With no snoozed or auto-settle work, there is no timer at all.
 */
export class LifecycleScheduler {
  #timer: ReturnType<typeof setTimeout> | undefined
  #scheduledRefreshAt: number | undefined
  #scheduleKnown = false
  #refreshing = false
  #disposed = false

  constructor(
    private readonly refresh: () => void,
    private readonly nextAt: () => number | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  refreshNow(): void {
    if (this.#disposed || this.#refreshing) return
    this.#clearTimer()
    this.#refreshing = true
    try {
      this.refresh()
    } finally {
      this.#refreshing = false
    }
    this.#schedule(BLOCKED_RETRY_MS)
  }

  /** Refreshes an overdue clock without repeating lifecycle reads on every sidebar fetch. */
  refreshIfDue(): void {
    if (
      this.#disposed ||
      this.#refreshing ||
      this.#scheduledRefreshAt === undefined ||
      this.#scheduledRefreshAt > this.now()
    ) {
      return
    }
    this.refreshNow()
  }

  changed(): void {
    if (this.#disposed || this.#refreshing) return
    this.#schedule(1)
  }

  /** Keep the known earlier wake when a mutation can only postpone or remove deadlines. */
  changedLater(): void {
    if (this.#disposed || this.#refreshing || this.#scheduleKnown) return
    this.#schedule(1)
  }

  /** Add one known deadline without rereading unchanged persisted deadlines. */
  deadlineAdded(at: number | undefined): void {
    if (this.#disposed || this.#refreshing || at === undefined) return
    if (!this.#scheduleKnown) {
      this.#schedule(1)
      return
    }
    this.#scheduleAt(at, 1, this.now())
  }

  dispose(): void {
    this.#disposed = true
    this.#clearTimer()
  }

  #schedule(overdueDelay: number): void {
    const now = this.now()
    const nextAt = this.nextAt()
    this.#scheduleKnown = true
    this.#scheduleAt(nextAt, overdueDelay, now)
  }

  #scheduleAt(nextAt: number | undefined, overdueDelay: number, now: number): void {
    if (nextAt === undefined) {
      this.#clearTimer()
      return
    }
    const delay = Math.min(MAX_TIMEOUT_MS, nextAt <= now ? overdueDelay : nextAt - now)
    const scheduledRefreshAt = now + delay
    if (
      this.#timer !== undefined &&
      this.#scheduledRefreshAt !== undefined &&
      this.#scheduledRefreshAt <= scheduledRefreshAt
    ) {
      return
    }
    this.#clearTimer()
    this.#scheduledRefreshAt = scheduledRefreshAt
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#scheduledRefreshAt = undefined
      this.refreshNow()
    }, delay)
    this.#timer.unref?.()
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#scheduledRefreshAt = undefined
  }
}
