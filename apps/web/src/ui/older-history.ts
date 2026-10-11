import type { Item } from '@harness/contracts'

/** Start loading older turns while this many viewports of transcript remain above. */
export const OLDER_HISTORY_PREFETCH_VIEWPORTS = 1.5

export function nearOlderHistoryEdge(element: HTMLElement): boolean {
  return element.scrollTop < element.clientHeight * OLDER_HISTORY_PREFETCH_VIEWPORTS
}

/**
 * Rows inserted above the previous first row, or 0 for any other change. Live
 * rows may have been appended in the same update, so the old first row is
 * searched for only within the grown prefix.
 */
export function prependedRowCount(previous: readonly Item[], next: readonly Item[]): number {
  const first = previous[0]
  if (!first || next.length <= previous.length || next[0]?.id === first.id) return 0
  for (let index = 1; index <= next.length - previous.length; index += 1) {
    if (next[index]?.id === first.id) return index
  }
  return 0
}
