/**
 * After a failed import behind a read, the waits before each retry. An open chat catches up
 * without being opened again; after the last one, its next read or turn tries again.
 */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000]

/**
 * Imports of a chat's outside turns that run behind a read which answered from the stored
 * transcript, by chat. One runs per chat at a time; requests that act on a chat wait for it.
 */
export class ImportsBehindReads {
  #running = new Map<string, Promise<void>>()
  #retries = new Map<string, ReturnType<typeof setTimeout>>()
  #closed = false

  constructor(
    private readonly options: {
      /** Imports the chat's outside turns; resolves whether that changed the chat. */
      load(threadId: string): Promise<boolean>
      /** The import changed the chat, so open clients should reload it. */
      changed(threadId: string): void
      retryDelaysMs?: readonly number[]
    },
  ) {}

  get size(): number {
    return this.#running.size
  }

  start(threadId: string, attempt = 0): void {
    if (this.#closed || this.#running.has(threadId)) return
    // A read while a retry waits imports at once, and starts the schedule over.
    clearTimeout(this.#retries.get(threadId))
    this.#retries.delete(threadId)
    const importing: Promise<void> = this.options.load(threadId).then(
      (changed) => {
        if (changed) this.options.changed(threadId)
      },
      () => this.#retry(threadId, attempt),
    )
    this.#running.set(threadId, importing)
    void importing.finally(() => {
      if (this.#running.get(threadId) === importing) this.#running.delete(threadId)
    })
  }

  /** Resolves once the imports running for these chats are done, whether or not they failed. */
  settled(threadIds: readonly string[]): Promise<void> | undefined {
    const running = threadIds.flatMap((threadId) => this.#running.get(threadId) ?? [])
    return running.length ? Promise.all(running).then(() => undefined) : undefined
  }

  /** Starts no import and no retry from now on. */
  close(): void {
    this.#closed = true
    for (const timer of this.#retries.values()) clearTimeout(timer)
    this.#retries.clear()
  }

  #retry(threadId: string, attempt: number): void {
    const delay = (this.options.retryDelaysMs ?? RETRY_DELAYS_MS)[attempt]
    if (this.#closed || delay === undefined) return
    const timer = setTimeout(() => {
      this.#retries.delete(threadId)
      this.start(threadId, attempt + 1)
    }, delay)
    timer.unref?.()
    this.#retries.set(threadId, timer)
  }
}
