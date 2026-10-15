import type { NativeMenuActionMessage } from './menu-contract.js'

type MenuTarget = {
  isDestroyed(): boolean
  send(channel: 'harness:menuAction', message: NativeMenuActionMessage): void
}

const MAX_PENDING_ACTIONS = 16

/**
 * Holds native menu actions until the page that handles them has installed its
 * listener. A new or reloading window accepts IPC before React has subscribed.
 */
export class NativeMenuDispatch<Target extends MenuTarget> {
  readonly #ready = new WeakSet<Target>()
  readonly #pending = new WeakMap<Target, NativeMenuActionMessage[]>()

  send(target: Target, message: NativeMenuActionMessage): void {
    if (target.isDestroyed()) return
    if (this.#ready.has(target)) {
      target.send('harness:menuAction', message)
      return
    }
    const pending = this.#pending.get(target) ?? []
    pending.push(message)
    this.#pending.set(target, pending.slice(-MAX_PENDING_ACTIONS))
  }

  markReady(target: Target): void {
    this.#ready.add(target)
    const pending = this.#pending.get(target)
    this.#pending.delete(target)
    if (target.isDestroyed()) return
    for (const message of pending ?? []) target.send('harness:menuAction', message)
  }

  /** A navigation replaces the page; actions sent from now on wait for its listener. */
  reset(target: Target): void {
    this.#ready.delete(target)
  }
}
