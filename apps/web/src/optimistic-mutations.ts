type Recovery = () => Promise<() => void>
type Mutation = { tail: Promise<void>; recovery?: Recovery }

/** Serial writes per field, with revision-checked reads after a refused write. */
export class OptimisticMutations {
  #entries = new Map<string, Mutation>()

  constructor(private reportError: (message: string) => void) {}

  run(key: string, save: () => Promise<unknown>, recovery: Recovery): Promise<void> {
    const previous = this.#entries.get(key)
    const mutation: Mutation = { tail: Promise.resolve() }
    this.#entries.set(key, mutation)
    mutation.tail = (previous?.tail ?? Promise.resolve())
      .then(save)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        this.reportError(error instanceof Error ? error.message : 'The change could not be saved.')
        if (this.#entries.get(key) !== mutation) return
        mutation.recovery = recovery
        await this.#recover(key, mutation)
      })
      .finally(() => {
        if (this.#entries.get(key) === mutation && !mutation.recovery) this.#entries.delete(key)
      })
    return mutation.tail
  }

  /** Retry failed reads when the connection returns, without repeating writes. */
  reconcile(): void {
    for (const [key, mutation] of this.#entries) {
      if (mutation.recovery) void this.#recover(key, mutation)
    }
  }

  async #recover(key: string, mutation: Mutation): Promise<void> {
    const recovery = mutation.recovery
    if (!recovery) return
    try {
      const apply = await recovery()
      if (this.#entries.get(key) !== mutation || mutation.recovery !== recovery) return
      apply()
      delete mutation.recovery
      this.#entries.delete(key)
    } catch {
      // A disconnected read stays owned until reconnect. It never guesses
      // whether a transmitted save reached the server.
    }
  }
}
