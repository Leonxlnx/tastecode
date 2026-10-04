import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  completePendingQueueRead,
  pruneInactiveQueueMetadata,
  pruneInactiveThreadStates,
} from './thread-state-cache.js'
import { emptyThread, type ThreadState } from './thread-store.js'
import { ThreadOwnedMap } from './workspace-idle.js'

const OPTIONS = { iterations: 100, time: 0, warmupIterations: 10, warmupTime: 0 }
const THREAD_COUNT = 1_000
const threadIds = Array.from({ length: THREAD_COUNT }, (_, index) => `thread-${index}`)

type QueueState = { items: string[]; canSteer: boolean }

function completedState(id: string, itemCount: number, text: string): ThreadState {
  const items: Item[] = Array.from({ length: itemCount }, (_, index) => ({
    id: `${id}-item-${index}`,
    turnId: `${id}-turn-${index}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: index,
  }))
  return { ...emptyThread, items }
}

const normalHistoryEntries = Array.from({ length: 4 }, (_, index) => {
  const id = `normal-${index}`
  return [id, completedState(id, 1_000, 'A normal completed assistant reply.')] as const
})
const oversizedHistoryEntries = Array.from({ length: 6 }, (_, index) => {
  const id = `oversized-${index}`
  return [id, completedState(id, 1, 'x'.repeat(16 * 1024 * 1024))] as const
})

const protectedRows = new ThreadOwnedMap<{ threadId: string }>()
for (let index = 0; index < 10_000; index += 1) {
  protectedRows.set(`row-${index}`, { threadId: `thread-${index}` })
}

function sparseMetadata() {
  const ids = ['thread-1', 'thread-5000', 'stale']
  return {
    queues: new Map<string, QueueState>(ids.map((id) => [id, { items: [], canSteer: false }])),
    localRevisions: new Map(ids.map((id) => [id, 1])),
    serverRevisions: new Map(ids.map((id) => [id, 1])),
  }
}

function makePendingReads() {
  return {
    queues: new Map<string, QueueState>(
      threadIds.map((id) => [id, { items: [], canSteer: false }]),
    ),
    localRevisions: new Map(threadIds.map((id) => [id, 1])),
    serverRevisions: new Map(threadIds.map((id) => [id, 1])),
    pendingReads: new Map(threadIds.map((id) => [id, 1])),
  }
}

describe('many-thread queue-read completion', () => {
  bench(
    'prunes metadata after every completed queue read',
    () => {
      const state = makePendingReads()
      for (const threadId of threadIds) {
        state.pendingReads.delete(threadId)
        pruneInactiveQueueMetadata(
          state.queues,
          state.localRevisions,
          state.serverRevisions,
          state.pendingReads,
        )
      }
      if (state.queues.size !== 0) throw new Error('stale queue metadata')
    },
    OPTIONS,
  )

  bench(
    'prunes metadata once after the concurrent read batch',
    () => {
      const state = makePendingReads()
      for (const threadId of threadIds) {
        if (!completePendingQueueRead(state.pendingReads, threadId)) continue
        pruneInactiveQueueMetadata(
          state.queues,
          state.localRevisions,
          state.serverRevisions,
          state.pendingReads,
        )
      }
      if (state.queues.size !== 0) throw new Error('stale queue metadata')
    },
    OPTIONS,
  )
})

describe('sparse cache pruning with many protected operations', () => {
  bench(
    'copies all 10,000 protected owners before pruning three cached threads',
    () => {
      const state = sparseMetadata()
      const protectedIds = new Set([...protectedRows.values()].map((entry) => entry.threadId))
      pruneInactiveQueueMetadata(
        state.queues,
        state.localRevisions,
        state.serverRevisions,
        new Map(),
        { protectedIds },
      )
      if (state.queues.size !== 2) throw new Error('lost protected metadata')
    },
    OPTIONS,
  )

  bench(
    'checks only the three cached threads through the owner index',
    () => {
      const state = sparseMetadata()
      pruneInactiveQueueMetadata(
        state.queues,
        state.localRevisions,
        state.serverRevisions,
        new Map(),
        { isProtected: (threadId) => protectedRows.countForThread(threadId) > 0 },
      )
      if (state.queues.size !== 2) throw new Error('lost protected metadata')
    },
    OPTIONS,
  )
})

describe('completed inactive transcript cache', () => {
  bench(
    'counts only the retained 3,000-item LRU suffix',
    () => {
      const states = new Map(normalHistoryEntries)
      const durable = new Map(normalHistoryEntries.map(([id], index) => [id, index + 1]))
      pruneInactiveThreadStates(states, durable)
      if (states.size !== 3) throw new Error('invalid normal cache size')
    },
    OPTIONS,
  )

  bench(
    'evicts six oversized one-item histories by character budget',
    () => {
      const states = new Map(oversizedHistoryEntries)
      const durable = new Map(oversizedHistoryEntries.map(([id], index) => [id, index + 1]))
      pruneInactiveThreadStates(states, durable)
      if (states.size !== 0) throw new Error('retained oversized history')
    },
    OPTIONS,
  )
})
