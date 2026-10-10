import type { Item } from '@harness/contracts'
import type { LiveItemUpdate } from './thread-store.js'

export type ThreadSearchIndex = {
  searchable: readonly string[]
}

export function createThreadSearchIndex(items: readonly Item[]): ThreadSearchIndex {
  return { searchable: items.map(searchableItemText) }
}

/**
 * Retain normalized history across structural updates. Rows are immutable, so
 * an identity check finds every row the reducer replaced, wherever it sits: a
 * parallel tool call completing above newer calls, or a streamed row
 * materialized below a new tail. Only replaced rows are normalized again.
 */
export function createThreadSearchIndexer(): (items: readonly Item[]) => ThreadSearchIndex {
  let previousItems: readonly Item[] = []
  const index: ThreadSearchIndex = { searchable: [] }
  const searchable = index.searchable as string[]

  return (items) => {
    if (items === previousItems) return index

    const shared = Math.min(items.length, previousItems.length)
    for (let itemIndex = 0; itemIndex < shared; itemIndex += 1) {
      const item = items[itemIndex]!
      if (item !== previousItems[itemIndex]) searchable[itemIndex] = searchableItemText(item)
    }
    for (let itemIndex = shared; itemIndex < items.length; itemIndex += 1) {
      searchable.push(searchableItemText(items[itemIndex]!))
    }
    searchable.length = items.length

    previousItems = items
    return index
  }
}

export function findThreadSearchHits(
  index: ThreadSearchIndex,
  liveItems: ReadonlyMap<number, LiveItemUpdate> | undefined,
  term: string,
): number[] {
  const hits: number[] = []
  if (!liveItems || liveItems.size === 0) {
    for (let itemIndex = 0; itemIndex < index.searchable.length; itemIndex += 1) {
      if (index.searchable[itemIndex]?.includes(term)) hits.push(itemIndex)
    }
    return hits
  }

  for (let itemIndex = 0; itemIndex < index.searchable.length; itemIndex += 1) {
    const live = liveItems.get(itemIndex)
    const searchable = live ? searchableItemText(live.item) : index.searchable[itemIndex]
    if (searchable?.includes(term)) hits.push(itemIndex)
  }
  return hits
}

function searchableItemText(item: Item): string {
  return `${item.text?.toLowerCase() ?? ''}\0${item.command?.toLowerCase() ?? ''}\0${item.path?.toLowerCase() ?? ''}`
}
