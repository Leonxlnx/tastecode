import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { emptyThread, threadItemById, type ThreadState } from './thread-store.js'
import {
  completePendingQueueRead,
  MAX_INACTIVE_THREAD_CHARACTERS,
  MAX_INACTIVE_THREAD_ITEMS,
  MAX_INACTIVE_THREAD_STATES,
  compactInactiveRunningThreadState,
  pruneInactiveQueueMetadata,
  pruneInactiveThreadStates,
  touchThreadState,
} from './thread-state-cache.js'

function state(id: string, itemCount: number, running = false): ThreadState {
  const items: Item[] = Array.from({ length: itemCount }, (_, index) => ({
    id: `${id}-item-${index}`,
    turnId: `${id}-turn-${index}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: 'x',
    createdAt: index,
  }))
  return { ...emptyThread, items, running }
}

function sequences(states: Map<string, ThreadState>): Map<string, number> {
  return new Map([...states.keys()].map((id, index) => [id, index + 1]))
}

describe('inactive thread history cache', () => {
  it('releases derived item indexes from completed inactive histories', () => {
    let idReads = 0
    const cached = state('cached', 100)
    for (const item of cached.items) {
      const id = item.id
      Object.defineProperty(item, 'id', {
        enumerable: true,
        get() {
          idReads += 1
          return id
        },
      })
    }
    const states = new Map<string, ThreadState>([['cached', cached]])

    expect(threadItemById(cached, 'cached-item-99')).toBe(cached.items[99])
    pruneInactiveThreadStates(states, sequences(states))
    const readsBeforeRebuild = idReads

    expect(threadItemById(states.get('cached')!, 'cached-item-99')).toBe(cached.items[99])
    expect(idReads - readsBeforeRebuild).toBeGreaterThanOrEqual(cached.items.length)
  })

  it('bounds old histories while retaining active and live work', () => {
    const states = new Map<string, ThreadState>([
      ['old', state('old', 2_000)],
      ['recent', state('recent', 1_000)],
      ['active', state('active', 4_000)],
      ['running', state('running', 4_000, true)],
      ['pending', state('pending', 4_000)],
    ])
    const durable = sequences(states)

    expect(
      pruneInactiveThreadStates(states, durable, {
        activeId: 'active',
        protectedIds: new Set(['pending']),
        maxInactiveStates: 1,
        maxInactiveItems: 1_200,
      }),
    ).toEqual(['old'])
    expect([...states.keys()]).toEqual(['recent', 'active', 'running', 'pending'])
    expect(durable.has('old')).toBe(false)
    expect(durable.has('recent')).toBe(true)
  })

  it('drops a long background transcript while retaining its lifecycle', () => {
    const background = {
      ...state('background', 300, true),
      liveStart: 290,
      liveItems: new Map([
        [
          299,
          {
            item: {
              ...state('streamed', 1).items[0]!,
              id: 'background-item-299',
              turnId: 'background-turn-299',
              status: 'started' as const,
              text: 'streamed tail',
            },
            version: 1,
            textUpdate: { kind: 'append' as const, text: ' tail' },
          },
        ],
      ]),
      activeTurn: { id: 'background-turn-299', startedAt: 290 },
      turnTiming: {
        'background-turn-0': { startedAt: 0, completedAt: 1 },
        'background-turn-299': { startedAt: 290 },
      },
    }
    const states = new Map<string, ThreadState>([['background', background]])
    const durable = sequences(states)

    expect(pruneInactiveThreadStates(states, durable)).toEqual([])
    expect(states.get('background')).toMatchObject({
      running: true,
      liveStart: 0,
      activeTurn: background.activeTurn,
    })
    expect(states.get('background')?.items).toEqual([])
    expect(states.get('background')?.liveItems.size).toBe(0)
    expect(states.get('background')?.turnTiming).toEqual({
      'background-turn-299': { startedAt: 290 },
    })
    expect(durable.has('background')).toBe(false)
  })

  it('drops a long transcript as soon as a background turn starts', () => {
    const background = {
      ...state('background', 10_001, true),
      liveStart: 10_000,
      activeTurn: { id: 'background-turn-10000', startedAt: 10_000 },
    }
    const states = new Map<string, ThreadState>([['background', background]])
    const durable = sequences(states)

    expect(compactInactiveRunningThreadState(states, durable, 'background')).toBe(true)
    expect(states.get('background')?.items).toEqual([])
    expect(durable.has('background')).toBe(false)
  })

  it('bounds a single large current reply without waiting for completion', () => {
    const item = {
      ...state('background', 1, true).items[0]!,
      status: 'started' as const,
      text: '',
    }
    const background = {
      ...emptyThread,
      items: [item],
      liveItems: new Map([
        [
          0,
          {
            item: { ...item, text: 'x'.repeat(300 * 1024) },
            version: 1,
            textUpdate: { kind: 'append' as const, text: 'x' },
          },
        ],
      ]),
      itemVersion: 1,
      running: true,
      activeTurn: { id: item.turnId, startedAt: 0 },
    }
    const states = new Map<string, ThreadState>([['background', background]])
    const durable = sequences(states)

    expect(compactInactiveRunningThreadState(states, durable, 'background')).toBe(true)
    expect(states.get('background')?.items).toEqual([])
    expect(durable.has('background')).toBe(false)
  })

  it('releases large display state while retaining live blockers', () => {
    const approval = {
      id: 'approval',
      kind: 'command' as const,
      command: 'pnpm test',
      createdAt: 1,
    }
    const userInput = {
      id: 'input',
      turnId: 'background-turn-0',
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          allowOther: false,
          secret: false,
          options: null,
        },
      ],
      autoResolutionMs: null,
      createdAt: 2,
    }
    const background = {
      ...state('background', 1, true),
      activeTurn: { id: 'background-turn-0', startedAt: 0 },
      plan: [{ text: 'Keep working', status: 'running' as const }],
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 2,
      },
      diff: 'x'.repeat(300 * 1024),
      diffTurnId: 'background-turn-0',
      approvals: [approval],
      userInputs: [userInput],
      reviews: {
        review: {
          id: 'review',
          turnId: 'background-turn-0',
          status: 'in_progress' as const,
          description: 'Review access',
          startedAt: 0,
        },
      },
    }
    const states = new Map<string, ThreadState>([['background', background]])
    const durable = sequences(states)

    expect(compactInactiveRunningThreadState(states, durable, 'background')).toBe(true)
    const compacted = states.get('background')!
    expect(compacted.running).toBe(true)
    expect(compacted.activeTurn).toEqual(background.activeTurn)
    expect(compacted.approvals).toEqual([approval])
    expect(compacted.userInputs).toEqual([userInput])
    expect(compacted.items).toEqual([])
    expect(compacted.plan).toEqual([])
    expect(compacted.usage).toBeUndefined()
    expect(compacted.diff).toBeUndefined()
    expect(compacted.diffTurnId).toBeUndefined()
    expect(compacted.reviews).toEqual({})
    expect(durable.has('background')).toBe(false)
  })

  it('keeps a short background running thread hot for instant selection', () => {
    const background = {
      ...state('background', 10, true),
      liveStart: 5,
      activeTurn: { id: 'background-turn-9', startedAt: 5 },
    }
    const states = new Map<string, ThreadState>([['background', background]])
    const durable = sequences(states)

    pruneInactiveThreadStates(states, durable)

    expect(states.get('background')).toBe(background)
    expect(durable.has('background')).toBe(true)
  })

  it('bounds the combined transcripts of many short background turns', () => {
    const entries = Array.from({ length: 10 }, (_, index) => {
      const id = `background-${index}`
      const background = {
        ...state(id, 101, true),
        liveStart: 100,
        activeTurn: { id: `${id}-turn-100`, startedAt: 100 },
      }
      return [id, background] as const
    })
    const states = new Map<string, ThreadState>(entries)
    const durable = sequences(states)
    const compacted: string[] = []

    pruneInactiveThreadStates(states, durable, {
      maxBackgroundRunningStates: 10,
      maxBackgroundRunningItems: 250,
      maxBackgroundRunningCharacters: Number.MAX_SAFE_INTEGER,
      onCompact: (threadId) => compacted.push(threadId),
    })

    expect(compacted).toEqual(entries.slice(0, 8).map(([id]) => id))
    for (const [id] of entries.slice(0, 8)) {
      expect(states.get(id)?.items).toHaveLength(0)
      expect(states.get(id)?.liveStart).toBe(0)
      expect(durable.has(id)).toBe(false)
    }
    for (const [id, background] of entries.slice(8)) {
      expect(states.get(id)).toBe(background)
      expect(durable.has(id)).toBe(true)
    }
  })

  it('bounds background workers even before their first transcript item', () => {
    const entries = Array.from({ length: 10 }, (_, index) => {
      const id = `background-${index}`
      return [
        id,
        {
          ...emptyThread,
          running: true,
          activeTurn: { id: `${id}-turn`, startedAt: index },
        },
      ] as const
    })
    const states = new Map<string, ThreadState>(entries)
    const durable = sequences(states)
    const compacted: string[] = []

    pruneInactiveThreadStates(states, durable, {
      maxBackgroundRunningStates: 2,
      maxBackgroundRunningItems: Number.MAX_SAFE_INTEGER,
      maxBackgroundRunningCharacters: Number.MAX_SAFE_INTEGER,
      onCompact: (threadId) => compacted.push(threadId),
    })

    expect(compacted).toEqual(entries.slice(0, 8).map(([id]) => id))
    expect([...durable.keys()]).toEqual(entries.slice(8).map(([id]) => id))
  })

  it('does not compact protected background work', () => {
    const background = {
      ...state('background', 300, true),
      liveStart: 290,
      activeTurn: { id: 'background-turn-299', startedAt: 290 },
    }
    const states = new Map<string, ThreadState>([['background', background]])
    const durable = sequences(states)

    pruneInactiveThreadStates(states, durable, {
      protectedIds: new Set(['background']),
    })

    expect(states.get('background')).toBe(background)
    expect(durable.has('background')).toBe(true)
  })

  it('accepts an indexed protection predicate without materializing a union set', () => {
    const protectedState = state('protected', 1)
    const staleState = state('stale', 1)
    const states = new Map<string, ThreadState>([
      ['protected', protectedState],
      ['stale', staleState],
    ])
    const durable = sequences(states)

    expect(
      pruneInactiveThreadStates(states, durable, {
        maxInactiveStates: 0,
        isProtected: (threadId) => threadId === 'protected',
      }),
    ).toEqual(['stale'])
    expect(states.get('protected')).toBe(protectedState)
  })

  it('uses selection order for least-recently-used eviction', () => {
    const states = new Map<string, ThreadState>([
      ['old', state('old', 1)],
      ['recent', state('recent', 1)],
    ])
    const durable = sequences(states)

    expect(touchThreadState(states, 'old')).toBe(states.get('old'))
    expect(
      pruneInactiveThreadStates(states, durable, {
        maxInactiveStates: 1,
        maxInactiveItems: 10,
      }),
    ).toEqual(['recent'])
    expect([...states.keys()]).toEqual(['old'])
  })

  it('retains only a fixed amount after visiting 100 long threads', () => {
    const states = new Map<string, ThreadState>(
      Array.from({ length: 100 }, (_, index) => [
        `thread-${index}`,
        state(`thread-${index}`, 1_000),
      ]),
    )
    states.set('active', state('active', 1_000))
    const durable = sequences(states)

    pruneInactiveThreadStates(states, durable, { activeId: 'active' })

    const inactive = [...states].filter(([id]) => id !== 'active').map(([, thread]) => thread)
    expect(inactive).toHaveLength(MAX_INACTIVE_THREAD_STATES)
    expect(inactive.reduce((total, thread) => total + thread.items.length, 0)).toBe(
      MAX_INACTIVE_THREAD_ITEMS,
    )
    expect([...states.values()].reduce((total, thread) => total + thread.items.length, 0)).toBe(
      4_000,
    )
  })

  it('evicts oversized completed text even when the item count is small', () => {
    const oversized = state('old', 1)
    oversized.items[0] = { ...oversized.items[0]!, text: 'x'.repeat(1_024) }
    const recent = state('recent', 1)
    const states = new Map<string, ThreadState>([
      ['old', oversized],
      ['recent', recent],
    ])
    const durable = sequences(states)

    expect(
      pruneInactiveThreadStates(states, durable, {
        maxInactiveStates: 10,
        maxInactiveItems: 10,
        maxInactiveCharacters: 100,
      }),
    ).toEqual(['old'])
    expect([...states.keys()]).toEqual(['recent'])
    expect(durable.has('old')).toBe(false)
  })

  it('includes retained diff text in the inactive character budget', () => {
    const oversized = { ...state('old', 0), diff: 'x'.repeat(1_024), diffTurnId: 'turn' }
    const recent = state('recent', 1)
    const states = new Map<string, ThreadState>([
      ['old', oversized],
      ['recent', recent],
    ])
    const durable = sequences(states)

    expect(
      pruneInactiveThreadStates(states, durable, {
        maxInactiveStates: 10,
        maxInactiveItems: 10,
        maxInactiveCharacters: 100,
      }),
    ).toEqual(['old'])
    expect([...states.keys()]).toEqual(['recent'])
  })

  it('keeps the default completed-history text budget bounded', () => {
    expect(MAX_INACTIVE_THREAD_CHARACTERS).toBe(8 * 1024 * 1024)
  })
})

describe('inactive thread queue cache', () => {
  it('defers global pruning until every concurrent queue read finishes', () => {
    const pendingReads = new Map([
      ['first', 1],
      ['second', 2],
    ])

    expect(completePendingQueueRead(pendingReads, 'first')).toBe(false)
    expect(completePendingQueueRead(pendingReads, 'second')).toBe(false)
    expect(completePendingQueueRead(pendingReads, 'second')).toBe(true)
    expect(pendingReads.size).toBe(0)
  })

  it('drops empty inactive queues while retaining active and live work', () => {
    const queues = new Map([
      ['stale', { items: [] as string[], canSteer: false }],
      ['active', { items: [] as string[], canSteer: false }],
      ['pending', { items: [] as string[], canSteer: false }],
      ['queued', { items: ['turn'], canSteer: true }],
    ])

    const localRevisions = new Map([...queues.keys()].map((id) => [id, 1]))
    const serverRevisions = new Map([...queues.keys()].map((id) => [id, 2]))

    expect(
      pruneInactiveQueueMetadata(queues, localRevisions, serverRevisions, new Map(), {
        activeId: 'active',
        protectedIds: new Set(['pending']),
      }),
    ).toEqual(['stale'])
    expect([...queues.keys()]).toEqual(['active', 'pending', 'queued'])
    expect([...localRevisions.keys()]).toEqual(['active', 'pending', 'queued'])
    expect([...serverRevisions.keys()]).toEqual(['active', 'pending', 'queued'])
  })

  it('does not retain empty queue objects after visiting many threads', () => {
    const queues = new Map(
      Array.from({ length: 10_000 }, (_, index) => [
        `thread-${index}`,
        { items: [] as string[], canSteer: false },
      ]),
    )

    const localRevisions = new Map([...queues.keys()].map((id) => [id, 1]))
    const serverRevisions = new Map([...queues.keys()].map((id) => [id, 2]))

    pruneInactiveQueueMetadata(queues, localRevisions, serverRevisions, new Map(), {
      activeId: 'thread-9999',
    })

    expect([...queues.keys()]).toEqual(['thread-9999'])
    expect([...localRevisions.keys()]).toEqual(['thread-9999'])
    expect([...serverRevisions.keys()]).toEqual(['thread-9999'])
  })

  it('retains revision guards until every queue read finishes', () => {
    const queues = new Map([['thread', { items: [] as string[], canSteer: false }]])
    const localRevisions = new Map([['thread', 4]])
    const serverRevisions = new Map([['thread', 7]])

    expect(
      pruneInactiveQueueMetadata(queues, localRevisions, serverRevisions, new Map([['thread', 1]])),
    ).toEqual([])
    expect(localRevisions.get('thread')).toBe(4)
    expect(serverRevisions.get('thread')).toBe(7)
  })

  it('prunes revision-only metadata without losing active or protected guards', () => {
    const queues = new Map<string, { items: string[]; canSteer: boolean }>()
    const localRevisions = new Map([
      ['active', 1],
      ['stale-local', 2],
    ])
    const serverRevisions = new Map([
      ['active', 3],
      ['stale-local', 4],
      ['protected', 5],
      ['stale-server', 6],
    ])

    expect(
      pruneInactiveQueueMetadata(queues, localRevisions, serverRevisions, new Map(), {
        activeId: 'active',
        protectedIds: new Set(['protected']),
      }),
    ).toEqual(['stale-local', 'stale-server'])
    expect([...localRevisions.keys()]).toEqual(['active'])
    expect([...serverRevisions.keys()]).toEqual(['active', 'protected'])
  })

  it('keeps queue metadata named by an indexed protection predicate', () => {
    const queues = new Map([
      ['protected', { items: [] as string[], canSteer: false }],
      ['stale', { items: [] as string[], canSteer: false }],
    ])
    const localRevisions = new Map([
      ['protected', 1],
      ['stale', 1],
    ])
    const serverRevisions = new Map([
      ['protected', 1],
      ['stale', 1],
    ])

    expect(
      pruneInactiveQueueMetadata(queues, localRevisions, serverRevisions, new Map(), {
        isProtected: (threadId) => threadId === 'protected',
      }),
    ).toEqual(['stale'])
    expect([...queues.keys()]).toEqual(['protected'])
  })
})
