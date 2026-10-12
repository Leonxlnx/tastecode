import type { Item } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  createThreadSearchIndex,
  createThreadSearchIndexer,
  findThreadSearchHits,
} from './thread-search-index.js'
import { emptyThread, reduce } from './thread-store.js'

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

    const replacedHead = project([{ ...items[0]!, id: 'other', text: 'Other' }])
    expect(findThreadSearchHits(replacedHead, undefined, 'other')).toEqual([0])
    expect(findThreadSearchHits(replacedHead, undefined, 'alpha')).toEqual([])
    expect(replacedHead.searchable).toHaveLength(1)
  })

  it('reindexes an earlier tool call that completes after later calls started', () => {
    const tool = (id: string, status: 'started' | 'completed', text: string): Item => ({
      id,
      turnId: 't1',
      type: 'tool_call',
      status,
      text,
      createdAt: 1,
    })
    const project = createThreadSearchIndexer()
    let state = reduce(emptyThread, {
      type: 'turn.started',
      turn: { id: 't1', threadId: 'th', status: 'running', createdAt: 1 },
    })
    for (const id of ['a', 'b', 'c']) {
      state = reduce(state, { type: 'item.started', item: tool(id, 'started', 'Read file') })
      project(state.items)
    }

    state = reduce(state, {
      type: 'item.completed',
      item: tool('a', 'completed', 'Read file needle.ts'),
    })

    expect(state.items[0]?.text).toContain('needle')
    expect(findThreadSearchHits(project(state.items), state.liveItems, 'needle')).toEqual([0])
  })

  it('reindexes a streamed row once it is materialized below a newer tail', () => {
    const project = createThreadSearchIndexer()
    let state = reduce(emptyThread, {
      type: 'turn.started',
      turn: { id: 't1', threadId: 'th', status: 'running', createdAt: 1 },
    })
    state = reduce(state, {
      type: 'item.started',
      item: {
        id: 'm',
        turnId: 't1',
        type: 'message',
        role: 'assistant',
        status: 'started',
        text: '',
        createdAt: 1,
      },
    })
    project(state.items)
    state = reduce(state, {
      type: 'item.started',
      item: {
        id: 'x',
        turnId: 't1',
        type: 'tool_call',
        status: 'started',
        text: 'Tool',
        createdAt: 2,
      },
    })
    project(state.items)
    state = reduce(state, {
      type: 'item.delta',
      turnId: 't1',
      itemId: 'm',
      textDelta: 'needle here',
    })
    project(state.items)
    state = reduce(state, {
      type: 'item.started',
      item: {
        id: 'y',
        turnId: 't1',
        type: 'tool_call',
        status: 'started',
        text: 'Tool',
        createdAt: 3,
      },
    })

    expect(state.liveItems.has(0)).toBe(false)
    expect(state.items[0]?.text).toBe('needle here')
    expect(findThreadSearchHits(project(state.items), state.liveItems, 'needle')).toEqual([0])
  })
})
