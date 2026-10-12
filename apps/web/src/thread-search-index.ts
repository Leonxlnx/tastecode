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

export type LiveThreadSearch = { live: readonly number[]; hits: readonly number[] }

export const NO_LIVE_THREAD_SEARCH: LiveThreadSearch = { live: [], hits: [] }

type LiveRowSearch = { id: string; scanned: number; matched: boolean }

/**
 * Live rows grow only by appended deltas, so each publish searches just the
 * new tail of every live row instead of rescanning the transcript. The result
 * keeps its identity until a live row starts matching or the live set changes.
 */
export function createLiveThreadSearch(): (
  liveItems: ReadonlyMap<number, LiveItemUpdate> | undefined,
  term: string,
) => LiveThreadSearch {
  let previousTerm = ''
  let rows = new Map<number, LiveRowSearch>()
  let result = NO_LIVE_THREAD_SEARCH

  return (liveItems, term) => {
    if (term !== previousTerm) rows = new Map()
    previousTerm = term
    const nextRows = new Map<number, LiveRowSearch>()
    for (const [index, { item }] of liveItems ?? []) {
      const length = item.text?.length ?? 0
      let row = rows.get(index)
      if (!row || row.id !== item.id || length < row.scanned) {
        row = { id: item.id, scanned: length, matched: searchableItemText(item).includes(term) }
      } else if (!row.matched && length > row.scanned) {
        // Overlap the previous tail so a match split across deltas is found.
        const tail = item.text!.slice(Math.max(0, row.scanned - term.length))
        row = { id: item.id, scanned: length, matched: tail.toLowerCase().includes(term) }
      }
      nextRows.set(index, row)
    }
    rows = nextRows

    const live = [...rows.keys()].sort((left, right) => left - right)
    const hits = live.filter((index) => rows.get(index)!.matched)
    if (sameIndices(live, result.live) && sameIndices(hits, result.hits)) return result
    result = { live, hits }
    return result
  }
}

/** Settled hits for rows that are not streaming, plus the live rows that match. */
export function mergeThreadSearchHits(
  settled: readonly number[],
  liveSearch: LiveThreadSearch,
): readonly number[] {
  if (liveSearch.live.length === 0) return settled
  const live = new Set(liveSearch.live)
  return [...settled.filter((index) => !live.has(index)), ...liveSearch.hits].sort(
    (left, right) => left - right,
  )
}

function sameIndices(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((index, position) => index === right[position])
}

function searchableItemText(item: Item): string {
  return `${item.text?.toLowerCase() ?? ''}\0${item.command?.toLowerCase() ?? ''}\0${item.path?.toLowerCase() ?? ''}`
}
