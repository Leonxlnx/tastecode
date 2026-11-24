import type { Item } from '@harness/contracts'
import { threadItemAt, type LiveItemUpdate } from '../thread-store.js'
import { isBlankReasoning } from './turns.js'

/** The first item from `from` on that renders a row: blank reasoning shows nothing. */
export function nextItemWithARow(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  from: number,
): Item | undefined {
  let index = from
  let item = threadItemAt(items, liveItems, index)
  while (item && isBlankReasoning(item)) {
    index += 1
    item = threadItemAt(items, liveItems, index)
  }
  return item
}
