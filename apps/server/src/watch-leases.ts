/** Visible settings views renew these; a one-shot read cannot retain a process forever. */
export class WatchLeases implements Iterable<string> {
  #expires = new Map<string, number>()

  constructor(readonly ttlMs = 60_000) {}

  add(key: string): void {
    this.#expires.set(key, Date.now() + this.ttlMs)
  }
  delete(key: string): void {
    this.#expires.delete(key)
  }
  clear(): void {
    this.#expires.clear()
  }
  get size(): number {
    this.prune()
    return this.#expires.size
  }
  get nextExpiry(): number | undefined {
    this.prune()
    let next: number | undefined
    for (const expiry of this.#expires.values()) next = Math.min(next ?? expiry, expiry)
    return next
  }
  prune(): void {
    const now = Date.now()
    for (const [key, expiry] of this.#expires) if (expiry <= now) this.#expires.delete(key)
  }
  *[Symbol.iterator](): Iterator<string> {
    this.prune()
    yield* this.#expires.keys()
  }
}
