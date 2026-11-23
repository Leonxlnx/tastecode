/**
 * Imports of a chat's outside turns that run behind a read which answered from the stored
 * transcript, by chat. One runs per chat at a time; requests that act on a chat wait for it.
 */
export class ImportsBehindReads {
  #running = new Map<string, Promise<void>>()

  constructor(
    private readonly options: {
      /** Imports the chat's outside turns; resolves whether that changed the chat. */
      load(threadId: string): Promise<boolean>
      /** The import changed the chat, so open clients should reload it. */
      changed(threadId: string): void
    },
  ) {}

  get size(): number {
    return this.#running.size
  }

  start(threadId: string): void {
    if (this.#running.has(threadId)) return
    const importing: Promise<void> = this.options
      .load(threadId)
      .then((changed) => {
        if (changed) this.options.changed(threadId)
      })
      // The chat's next read or turn retries the import.
      .catch(() => undefined)
      .finally(() => {
        if (this.#running.get(threadId) === importing) this.#running.delete(threadId)
      })
    this.#running.set(threadId, importing)
  }

  /** Resolves once the imports running for these chats are done, whether or not they failed. */
  settled(threadIds: readonly string[]): Promise<void> | undefined {
    const running = threadIds.flatMap((threadId) => this.#running.get(threadId) ?? [])
    return running.length ? Promise.all(running).then(() => undefined) : undefined
  }
}
