/** How long no delta may arrive before background work counts the stream as paused. */
export const STREAM_QUIET_MS = 2_000
/** Background work waits at most this long, so a long answer cannot starve it. */
export const STREAM_QUIET_MAX_WAIT_MS = 10_000

/**
 * Holds background work while a turn streams.
 *
 * The server streams every turn on the same event loop that starts provider
 * CLIs and scans saved sessions. A version probe or a fresh limit read starts
 * a process synchronously, and a history refresh can read an index for
 * hundreds of milliseconds; during a stream that arrives as a burst of deltas
 * after a visible stall. Work nobody is waiting for asks `whenQuiet()` first.
 * A user's own request (a sign-in, an account check after switching provider,
 * a reset) never waits here.
 */
export class StreamQuiet {
  #lastDeltaAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly quietMs = STREAM_QUIET_MS,
    private readonly maxWaitMs = STREAM_QUIET_MAX_WAIT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called for every streamed delta, so it only records the time. */
  noteDelta(): void {
    this.#lastDeltaAt = this.now()
  }

  /** Resolves at once when nothing streams, else after a pause or the longest wait. */
  whenQuiet(): Promise<void> {
    if (this.now() - this.#lastDeltaAt >= this.quietMs) return Promise.resolve()
    const deadline = this.now() + this.maxWaitMs
    return new Promise((resolve) => {
      const check = () => {
        const now = this.now()
        const quietIn = this.quietMs - (now - this.#lastDeltaAt)
        if (quietIn <= 0 || now >= deadline) {
          resolve()
          return
        }
        setTimeout(check, Math.min(quietIn, deadline - now)).unref?.()
      }
      check()
    })
  }
}
