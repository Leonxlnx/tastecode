import type { Item } from '@harness/contracts'
import { bench, describe } from 'vitest'
import {
  createThreadSearchIndex,
  createThreadSearchIndexer,
  findThreadSearchHits,
} from './thread-search-index.js'

const OPTIONS = { iterations: 30, time: 0, warmupIterations: 5, warmupTime: 0 }
const items: Item[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `item-${index}`,
  turnId: `turn-${Math.floor(index / 2)}`,
  type: 'message' as const,
  role: 'assistant' as const,
  status: 'completed' as const,
  text: `Completed performance work for thread ${index} with enough text to model a real result.`,
  createdAt: index,
}))
const index = createThreadSearchIndex(items)
const appendedItem: Item = {
  ...items.at(-1)!,
  id: 'appended',
  text: 'Appended structural row',
}
const structuralFrames = [items, [...items, appendedItem]]
const projectIndex = createThreadSearchIndexer()
projectIndex(items)
let structuralFrame = 0

function legacyFind(term: string): number[] {
  const hits: number[] = []
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex]
    if (
      item &&
      (item.text?.toLowerCase().includes(term) ||
        item.command?.toLowerCase().includes(term) ||
        item.path?.toLowerCase().includes(term))
    ) {
      hits.push(itemIndex)
    }
  }
  return hits
}

function cachedFindThroughEmptyLiveMap(term: string): number[] {
  const hits: number[] = []
  const live = new Map()
  for (let itemIndex = 0; itemIndex < index.searchable.length; itemIndex += 1) {
    const searchable = live.get(itemIndex) ?? index.searchable[itemIndex]
    if (searchable?.includes(term)) hits.push(itemIndex)
  }
  return hits
}

describe('long-thread local search', () => {
  bench(
    'normalizes 10,000 legacy items for one query',
    () => {
      if (legacyFind('performance').length !== 10_000) throw new Error('invalid legacy hits')
    },
    OPTIONS,
  )

  bench(
    'searches 10,000 cached item strings',
    () => {
      if (findThreadSearchHits(index, undefined, 'performance').length !== 10_000) {
        throw new Error('invalid indexed hits')
      }
    },
    OPTIONS,
  )

  bench(
    'checks an empty live map for 10,000 cached strings',
    () => {
      if (cachedFindThroughEmptyLiveMap('performance').length !== 10_000) {
        throw new Error('invalid empty-map hits')
      }
    },
    OPTIONS,
  )
})

describe('long-thread search index updates', () => {
  bench(
    'renormalizes 10,000 items after one tail change',
    () => {
      structuralFrame = structuralFrame === 0 ? 1 : 0
      const projected = createThreadSearchIndex(structuralFrames[structuralFrame]!)
      if (projected.searchable.length !== structuralFrames[structuralFrame]!.length) {
        throw new Error('invalid rebuilt index')
      }
    },
    OPTIONS,
  )

  bench(
    'updates only the changed search index tail',
    () => {
      structuralFrame = structuralFrame === 0 ? 1 : 0
      const projected = projectIndex(structuralFrames[structuralFrame]!)
      if (projected.searchable.length !== structuralFrames[structuralFrame]!.length) {
        throw new Error('invalid retained index')
      }
    },
    OPTIONS,
  )
})
