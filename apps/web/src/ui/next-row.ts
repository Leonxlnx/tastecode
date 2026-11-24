import type { Item } from '@harness/contracts'
import { threadItemAt, type LiveItemUpdate } from '../thread-store.js'
import { isBlankReasoning } from './turns.js'

/**
 * Per structural item array: where the walk from an index ends (the array's
 * length when no row follows) and the length it was answered at. Rows re-render
 * on every streamed delta of their own item, but the items after them only
 * change with a new array, so the walk runs once per array and index.
 */
const nextRows = new WeakMap<readonly Item[], Map<number, { end: number; length: number }>>()

/** The first item from `from` on that renders a row: blank reasoning shows nothing. */
export function nextItemWithARow(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  from: number,
): Item | undefined {
  // A live update in the walked range is newer than the array; walk it directly.
  for (const index of liveItems.keys()) if (index >= from) return walk(items, liveItems, from)
  let answers = nextRows.get(items)
  const known = answers?.get(from)
  if (known && known.length === items.length) return items[known.end]
  let end = from
  while (end < items.length && isBlankReasoning(items[end]!)) end += 1
  if (!answers) {
    answers = new Map()
    nextRows.set(items, answers)
  }
  answers.set(from, { end, length: items.length })
  return items[end]
}

function walk(
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
