import type { Item } from '@harness/contracts'
import type { LiveItemUpdate } from './thread-store.js'

export type ThreadSearchIndex = {
  searchable: readonly string[]
}

export function createThreadSearchIndex(items: readonly Item[]): ThreadSearchIndex {
  return { searchable: items.map(searchableItemText) }
}

/** Retain normalized history when one immutable structural tail update arrives. */
export function createThreadSearchIndexer(): (items: readonly Item[]) => ThreadSearchIndex {
  let previousItems: readonly Item[] | undefined
  let index: ThreadSearchIndex = { searchable: [] }

  return (items) => {
    if (items === previousItems) return index

    if (
      previousItems &&
      items.length === previousItems.length + 1 &&
      (previousItems.length === 0 || previousItems.at(-1) === items[previousItems.length - 1])
    ) {
      ;(index.searchable as string[]).push(searchableItemText(items.at(-1)!))
    } else if (
      previousItems &&
      previousItems.length === items.length + 1 &&
      (items.length === 0 || items.at(-1) === previousItems[items.length - 1])
    ) {
      ;(index.searchable as string[]).pop()
    } else if (
      previousItems &&
      items.length === previousItems.length &&
      items.length > 0 &&
      (items.length === 1 || previousItems.at(-2) === items.at(-2))
    ) {
      ;(index.searchable as string[])[items.length - 1] = searchableItemText(items.at(-1)!)
    } else {
      index = createThreadSearchIndex(items)
    }

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
