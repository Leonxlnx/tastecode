import type { Item } from '@harness/contracts'
import { useCallback, useRef } from 'react'

/**
 * Keeps TanStack's key extractor stable while a history generation streams.
 * Changing its identity makes virtual-core rebuild every measurement, so the
 * current items live in a ref and only session/history boundaries invalidate it.
 */
export function useVirtualItemKey(
  items: readonly Item[],
  threadId: string | undefined,
): (index: number) => string | number {
  const itemsRef = useRef(items)
  itemsRef.current = items
  // Completed history is immutable. Its first object therefore acts as an
  // O(1) generation sentinel: streaming and appends retain it, while replay,
  // restore and resync rebuild it.
  const historyIdentity = items.length === 1 ? items[0]?.id : items[0]

  return useCallback(
    (index: number) => itemsRef.current[index]?.id ?? index,
    [threadId, historyIdentity],
  )
}
