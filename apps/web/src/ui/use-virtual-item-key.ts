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
  historyGeneration: number,
): (index: number) => string | number {
  const itemsRef = useRef(items)
  itemsRef.current = items

  return useCallback(
    (index: number) => itemsRef.current[index]?.id ?? index,
    [threadId, historyGeneration],
  )
}
