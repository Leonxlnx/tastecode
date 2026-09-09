import type { Item } from '@harness/contracts'

/** Rows that should animate after one immutable transcript update. */
export function enteringThreadItems(previous: readonly Item[], items: Item[]): Item[] {
  if (items.length > previous.length) {
    const appendedCount = items.length - previous.length
    // Loading history is one replacement, not thousands of live appends. Do
    // not copy that history just to decide that none of it should animate.
    if (previous.length === 0 && appendedCount > 1) return []
    return items.slice(previous.length)
  }

  if (items.length !== previous.length || items.length === 0) return []
  const previousTail = previous.at(-1)
  const nextTail = items.at(-1)
  const prefixStayedStable = items.length === 1 || previous.at(-2)?.id === items.at(-2)?.id
  const reconciledLocalEcho =
    previousTail?.id.startsWith('local:') === true &&
    previousTail.role === 'user' &&
    nextTail?.role === 'user' &&
    previousTail.text === nextTail.text

  return prefixStayedStable && nextTail && previousTail?.id !== nextTail.id && !reconciledLocalEcho
    ? [nextTail]
    : []
}
