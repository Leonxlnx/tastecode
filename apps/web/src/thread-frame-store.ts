import { changedLiveItemIndices, type ThreadState } from './thread-store.js'

type Listener = () => void
type ItemRangeSubscription = { first: number; last: number; listener: Listener }

function hasStructuralChange(previous: ThreadState, next: ThreadState): boolean {
  return (
    previous.items !== next.items ||
    previous.error !== next.error ||
    previous.liveStart !== next.liveStart ||
    previous.running !== next.running ||
    previous.activeTurn !== next.activeTurn ||
    previous.turnTiming !== next.turnTiming ||
    previous.plan !== next.plan ||
    previous.usage !== next.usage ||
    previous.diff !== next.diff ||
    previous.diffTurnId !== next.diffTurnId ||
    previous.approvals !== next.approvals ||
    previous.userInputs !== next.userInputs ||
    previous.reviews !== next.reviews
  )
}

/**
 * The active transcript changes once per rendered text frame. Keeping that
 * snapshot outside App lets React update the thread without rerunning the
 * whole shell for every provider burst.
 */
export class ThreadFrameStore {
  readonly #listeners = new Set<Listener>()
  readonly #structureListeners = new Set<Listener>()
  readonly #itemListeners = new Map<number, Set<Listener>>()
  readonly #itemRangeListeners = new Set<ItemRangeSubscription>()
  #snapshot: ThreadState
  #structureSnapshot: ThreadState

  constructor(initial: ThreadState) {
    this.#snapshot = initial
    this.#structureSnapshot = initial
  }

  readonly getSnapshot = (): ThreadState => this.#snapshot

  /**
   * Text deltas keep every structural field stable. Consumers that lay out the
   * transcript subscribe here so a provider burst cannot rerun the virtual
   * list; the one changed row subscribes by index below.
   */
  readonly getStructureSnapshot = (): ThreadState => this.#structureSnapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly subscribeStructure = (listener: Listener): (() => void) => {
    this.#structureListeners.add(listener)
    return () => this.#structureListeners.delete(listener)
  }

  subscribeItems(indices: readonly number[], listener: Listener): () => void {
    for (const index of indices) {
      let listeners = this.#itemListeners.get(index)
      if (!listeners) {
        listeners = new Set()
        this.#itemListeners.set(index, listeners)
      }
      listeners.add(listener)
    }
    return () => {
      for (const index of indices) {
        const listeners = this.#itemListeners.get(index)
        listeners?.delete(listener)
        if (listeners?.size === 0) this.#itemListeners.delete(index)
      }
    }
  }

  /** Subscribe one contiguous activity group without one map entry per row. */
  subscribeItemRange(first: number, last: number, listener: Listener): () => void {
    const subscription = { first, last, listener }
    this.#itemRangeListeners.add(subscription)
    return () => this.#itemRangeListeners.delete(subscription)
  }

  #collectItemListeners(index: number, listeners: Set<Listener>): void {
    for (const listener of this.#itemListeners.get(index) ?? []) listeners.add(listener)
    for (const subscription of this.#itemRangeListeners) {
      if (index >= subscription.first && index <= subscription.last) {
        listeners.add(subscription.listener)
      }
    }
  }

  publish(snapshot: ThreadState): void {
    if (snapshot === this.#snapshot) return
    const previous = this.#snapshot
    this.#snapshot = snapshot

    const structural = hasStructuralChange(previous, snapshot)
    const changedItemListeners = new Set<Listener>()
    const changedIndices = structural
      ? undefined
      : changedLiveItemIndices(previous.liveItems, snapshot.liveItems)
    if (previous.liveItems === snapshot.liveItems) {
      // Structural events often keep the live text overlay unchanged.
    } else if (changedIndices && this.#itemRangeListeners.size === 0) {
      for (const index of changedIndices) {
        for (const listener of this.#itemListeners.get(index) ?? []) {
          changedItemListeners.add(listener)
        }
      }
    } else if (changedIndices) {
      for (const index of changedIndices) this.#collectItemListeners(index, changedItemListeners)
    } else if (this.#itemRangeListeners.size === 0) {
      for (const [index, update] of previous.liveItems) {
        if (snapshot.liveItems.get(index) === update) continue
        for (const listener of this.#itemListeners.get(index) ?? []) {
          changedItemListeners.add(listener)
        }
      }
      for (const [index, update] of snapshot.liveItems) {
        if (previous.liveItems.get(index) === update) continue
        for (const listener of this.#itemListeners.get(index) ?? []) {
          changedItemListeners.add(listener)
        }
      }
    } else {
      for (const [index, update] of previous.liveItems) {
        if (snapshot.liveItems.get(index) === update) continue
        this.#collectItemListeners(index, changedItemListeners)
      }
      for (const [index, update] of snapshot.liveItems) {
        if (previous.liveItems.get(index) === update) continue
        this.#collectItemListeners(index, changedItemListeners)
      }
    }

    if (structural) this.#structureSnapshot = snapshot
    for (const listener of this.#listeners) listener()
    for (const listener of changedItemListeners) listener()
    if (structural) for (const listener of this.#structureListeners) listener()
  }
}
