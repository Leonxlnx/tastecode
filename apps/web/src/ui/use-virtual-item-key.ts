import type { Item } from '@harness/contracts'
import { useLayoutEffect, useRef } from 'react'

type KeyGetter = (index: number) => string | number

type CommittedBoundary = {
  threadId: string | undefined
  historyIdentity: Item | string | undefined
  count: number
  tailId: string | undefined
  getItemKey: KeyGetter
}

/**
 * Keeps TanStack's key extractor stable while a history generation streams.
 * Changing its identity makes virtual-core rebuild every measurement, so the
 * current items live in a ref and only structural key boundaries invalidate it.
 */
export function useVirtualItemKey(items: readonly Item[], threadId: string | undefined): KeyGetter {
  const itemsRef = useRef(items)
  itemsRef.current = items
  // Completed history is immutable. Its first object therefore acts as an
  // O(1) generation sentinel: streaming and appends retain it, while replay,
  // restore and resync rebuild it.
  const historyIdentity = items.length === 1 ? items[0]?.id : items[0]
  const tailId = items.at(-1)?.id
  const committed = useRef<CommittedBoundary>(undefined)
  const previous = committed.current
  const canReuse =
    previous !== undefined &&
    previous.threadId === threadId &&
    previous.historyIdentity === historyIdentity &&
    // Count changes already invalidate virtual-core's measurement memo. Reuse
    // the getter for pure appends/trims, but refresh it when optimistic IDs are
    // reconciled in place at the same index.
    (previous.count !== items.length || previous.tailId === tailId)
  const getItemKey: KeyGetter = canReuse
    ? previous.getItemKey
    : (index) => itemsRef.current[index]?.id ?? index

  useLayoutEffect(() => {
    committed.current = {
      threadId,
      historyIdentity,
      count: items.length,
      tailId,
      getItemKey,
    }
  }, [threadId, historyIdentity, items.length, tailId, getItemKey])

  return getItemKey
}
