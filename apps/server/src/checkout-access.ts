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

  beginTurn(directory: string, owner: string): void {
    const root = canonicalCheckoutRoot(directory)
    if (this.#exclusive.has(root))
      throw new Error('cannot start a turn while this checkout is being restored or switched')
    const owners = this.#writers.get(root) ?? new Set<string>()
    owners.add(owner)
    this.#writers.set(root, owners)
  }

  /** Transfer an in-flight start's guard to the process that still must stop. */
  retainStopping(directory: string, owner: string): void {
    const root = canonicalCheckoutRoot(directory)
    const owners = this.#writers.get(root) ?? new Set<string>()
    owners.add(owner)
    this.#writers.set(root, owners)
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
      throw new Error('stop running turns in this checkout before restoring or switching branches')
    this.#exclusive.add(root)
    try {
      return await operation()
    } finally {
      this.#exclusive.delete(root)
    }
  }
}
