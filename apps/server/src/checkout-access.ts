import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Identify the checkout, not the shared Git object directory of its worktrees. */
export function canonicalCheckoutRoot(directory: string): string {
  let resolved = path.resolve(directory)
  for (let ancestor = resolved; ; ancestor = path.dirname(ancestor)) {
    if (existsSync(ancestor)) {
      resolved = path.resolve(realpathSync(ancestor), path.relative(ancestor, resolved))
      break
    }
    if (path.dirname(ancestor) === ancestor) break
  }
  for (let current = resolved; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return current
    if (path.dirname(current) === current) return resolved
  }
}

/** Turns may share a checkout; replacing files requires exclusive access. */
export class CheckoutAccess {
  #writers = new Map<string, Set<string>>()
  #exclusive = new Set<string>()
  /** For each owner's current or last turn: the other writers that shared its checkout. */
  #coWriters = new Map<string, Set<string>>()

  beginTurn(directory: string, owner: string): void {
    const root = canonicalCheckoutRoot(directory)
    if (this.#exclusive.has(root))
      throw new Error('cannot start a turn while this checkout is being restored or switched')
    const owners = this.#writers.get(root) ?? new Set<string>()
    this.#coWriters.set(owner, new Set())
    owners.add(owner)
    this.#meet(owners, owner)
    this.#writers.set(root, owners)
  }

  /**
   * The other writers that worked in this owner's checkout at any point since
   * its turn began. Its files may then hold their changes too.
   */
  coWritersSinceBegin(owner: string): ReadonlySet<string> {
    return this.#coWriters.get(owner) ?? new Set()
  }

  /** Transfer an in-flight start's guard to the process that still must stop. */
  retainStopping(directory: string, owner: string): void {
    const root = canonicalCheckoutRoot(directory)
    const owners = this.#writers.get(root) ?? new Set<string>()
    owners.add(owner)
    this.#meet(owners, owner)
    this.#writers.set(root, owners)
  }

  /** `owner` and every other writer in `owners` now share a checkout. */
  #meet(owners: ReadonlySet<string>, owner: string): void {
    for (const other of owners) {
      if (other === owner) continue
      this.#coWriterSet(owner).add(other)
      this.#coWriterSet(other).add(owner)
    }
  }

  #coWriterSet(owner: string): Set<string> {
    let set = this.#coWriters.get(owner)
    if (!set) {
      set = new Set()
      this.#coWriters.set(owner, set)
    }
    return set
  }

  endTurn(owner: string): void {
    for (const [root, owners] of this.#writers) {
      owners.delete(owner)
      if (owners.size === 0) this.#writers.delete(root)
    }
  }

  async exclusive<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    const root = canonicalCheckoutRoot(directory)
    if (this.#exclusive.has(root))
      throw new Error('another restore or branch switch is running in this checkout')
    if (this.#writers.get(root)?.size)
      throw new Error(
        'Chats are still working in this folder. Wait for them to finish or stop them, then try again.',
      )
    this.#exclusive.add(root)
    try {
      return await operation()
    } finally {
      this.#exclusive.delete(root)
    }
  }
}
