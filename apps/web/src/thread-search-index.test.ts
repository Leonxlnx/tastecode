import type { Item } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  createThreadSearchIndex,
  createThreadSearchIndexer,
  findThreadSearchHits,
} from './thread-search-index.js'

const items: Item[] = [
  {
    id: 'message',
    turnId: 'turn-1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: 'Alpha answer',
    createdAt: 1,
  },
  {
    id: 'command',
    turnId: 'turn-1',
    type: 'command',
    status: 'completed',
    command: 'pnpm test',
    path: 'apps/web',
    createdAt: 2,
  },
]

describe('thread search index', () => {
  it('searches text, commands, and paths without renormalizing the transcript', () => {
    const index = createThreadSearchIndex(items)

    expect(findThreadSearchHits(index, undefined, 'alpha')).toEqual([0])
    expect(findThreadSearchHits(index, undefined, 'pnpm')).toEqual([1])
    expect(findThreadSearchHits(index, undefined, 'apps/web')).toEqual([1])
  })

  it('uses the current live item while keeping settled rows indexed', () => {
    const index = createThreadSearchIndex(items)
    const live = new Map([
      [
        0,
        {
          item: { ...items[0]!, status: 'started' as const, text: 'Streaming beta' },
          version: 1,
          textUpdate: { kind: 'append' as const, text: ' beta' },
        },
      ],
    ])

    expect(findThreadSearchHits(index, live, 'alpha')).toEqual([])
    expect(findThreadSearchHits(index, live, 'beta')).toEqual([0])
    expect(findThreadSearchHits(index, live, 'pnpm')).toEqual([1])
  })

  it('retains append, trim, and tail replacement updates exactly', () => {
    const project = createThreadSearchIndexer()
    const initial = project(items)
    const appendedItem = { ...items[0]!, id: 'appended', text: 'Gamma' }
    const appended = project([...items, appendedItem])

    expect(appended).toBe(initial)
    expect(findThreadSearchHits(appended, undefined, 'gamma')).toEqual([2])

    const replacedItem = { ...appendedItem, text: 'Delta' }
    const replaced = project([...items, replacedItem])
    expect(replaced).toBe(initial)
    expect(findThreadSearchHits(replaced, undefined, 'gamma')).toEqual([])
    expect(findThreadSearchHits(replaced, undefined, 'delta')).toEqual([2])

    const trimmed = project(items)
    expect(trimmed).toBe(initial)
    expect(trimmed.searchable).toHaveLength(2)

    const rebuilt = project([{ ...items[0]!, id: 'other', text: 'Other' }])
    expect(rebuilt).not.toBe(initial)
    expect(findThreadSearchHits(rebuilt, undefined, 'other')).toEqual([0])
  })
})
