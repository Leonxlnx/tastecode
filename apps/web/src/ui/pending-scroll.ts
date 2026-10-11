import type { Virtualizer } from '@tanstack/react-virtual'

/**
 * Virtual-core keeps an in-flight scrollToIndex (a find, search or turn jump)
 * as a row index across count changes, so rows prepended while it settles
 * would land it `shift` rows early.
 */
export function shiftPendingScrollIndex(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  shift: number,
): void {
  // A private field, so read it without claiming a type for the whole instance.
  const pending: unknown = Reflect.get(virtualizer, 'scrollState')
  if (typeof pending !== 'object' || pending === null || !('index' in pending)) return
  if (typeof pending.index === 'number') pending.index += shift
}
