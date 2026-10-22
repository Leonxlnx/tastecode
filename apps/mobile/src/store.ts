import { useSyncExternalStore } from 'react'

/**
 * A value React components can read and follow. Updates replace the value;
 * selectors must return something already held in it (or a primitive), so an
 * unrelated update does not re-render a component.
 */
export class Store<T> {
  #value: T
  #listeners = new Set<() => void>()

  constructor(initial: T) {
    this.#value = initial
  }

  get = (): T => this.#value

  set(next: T | ((current: T) => T)): void {
    const value = typeof next === 'function' ? (next as (current: T) => T)(this.#value) : next
    if (Object.is(value, this.#value)) return
    this.#value = value
    for (const listener of this.#listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

export function useStore<T>(store: Store<T>): T
export function useStore<T, S>(store: Store<T>, select: (value: T) => S): S
export function useStore<T, S>(store: Store<T>, select?: (value: T) => S): T | S {
  return useSyncExternalStore(store.subscribe, () => (select ? select(store.get()) : store.get()))
}
