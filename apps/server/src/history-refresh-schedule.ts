/** The cadence while saved sessions keep changing or a client is active. */
export const HISTORY_REFRESH_MIN_MS = 15_000
/** The slowest cadence, reached after a few refreshes that found nothing new. */
export const HISTORY_REFRESH_MAX_MS = 120_000

/**
 * When the next provider-history refresh runs.
 *
 * Each refresh stats every saved session and reads the ones that changed, so a
 * fixed 15 s timer cost CPU all day while nothing changed. A refresh that finds
 * a change keeps the 15 s cadence; one that finds nothing doubles the wait, up
 * to 2 min. Client activity (opening a chat, listing projects) brings it back
 * to 15 s, so a session started in an outside CLI shows up at most 2 min later
 * while the app sits idle, and within 15 s once someone uses it.
 */
export class HistoryRefreshSchedule {
  #delay = HISTORY_REFRESH_MIN_MS
  #timer: ReturnType<typeof setTimeout> | undefined
  #dueAt: number | undefined
  #running = false
  /** Set by activity during a refresh, so the refresh that ends does not slow down. */
  #activeDuringRun = false
  #stopped = true

  constructor(
    /** Resolves whether anything changed. A failure counts as no change. */
    private readonly refresh: () => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The first refresh runs one minimum interval from now. */
  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.#delay = HISTORY_REFRESH_MIN_MS
    this.#schedule()
  }

  /** A client is using the app: refresh at the fast cadence again. */
  activity(): void {
    if (this.#stopped) return
    this.#delay = HISTORY_REFRESH_MIN_MS
    // A refresh under way schedules the next one at the fast cadence when it ends.
    if (this.#running) {
      this.#activeDuringRun = true
      return
    }
    if (this.#dueAt !== undefined && this.#dueAt <= this.now() + HISTORY_REFRESH_MIN_MS) return
    this.#schedule()
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#dueAt = undefined
  }

  /** The wait before the next refresh, for tests and diagnostics. */
  get delay(): number {
    return this.#delay
  }

  #schedule(): void {
    clearTimeout(this.#timer)
    this.#dueAt = this.now() + this.#delay
    this.#timer = setTimeout(() => void this.#run(), this.#delay)
    this.#timer.unref?.()
  }

  async #run(): Promise<void> {
    this.#timer = undefined
    this.#dueAt = undefined
    this.#running = true
    this.#activeDuringRun = false
    let changed = false
    try {
      changed = await this.refresh()
    } catch {
      // The next refresh retries.
    } finally {
      this.#running = false
    }
    if (this.#stopped) return
    this.#delay =
      changed || this.#activeDuringRun
        ? HISTORY_REFRESH_MIN_MS
        : Math.min(this.#delay * 2, HISTORY_REFRESH_MAX_MS)
    this.#schedule()
  }
}
