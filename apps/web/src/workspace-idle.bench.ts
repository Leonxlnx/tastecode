import { bench, describe } from 'vitest'
import {
  indexQueueItemIdsForChecks,
  indexWorkspaceSessions,
  ThreadOwnedMap,
  workspaceProjectActivity,
  type WorkspaceActivitySession,
} from './workspace-idle.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const sessions: WorkspaceActivitySession[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `thread-${index}`,
  running: false,
  status: 'idle',
}))
const queueStates = new Map<string, { items: readonly unknown[] }>()
const unknownQueues = new Set<string>()
const actions = Array.from({ length: 1_000 }, (_, index) => ({
  threadId: `thread-${index * 10}`,
  pending: index === 999 ? 0 : 1,
}))
const projects = Array.from({ length: 100 }, (_, projectIndex) => ({
  path: `/project-${projectIndex}`,
  sessions: Array.from({ length: 100 }, (_, sessionIndex) => ({
    id: `project-thread-${projectIndex * 100 + sessionIndex}`,
    running: false,
  })),
}))
const lookupIds = Array.from({ length: 1_000 }, (_, index) =>
  index % 2 === 0 ? `project-thread-${index * 9}` : `missing-${index}`,
)
const ownedRows = new Map<string, { threadId: string; token: number }>()
const indexedOwnedRows = new ThreadOwnedMap<{ threadId: string; token: number }>()
for (let index = 0; index < 10_000; index += 1) {
  const id = `queue-${index}`
  const value = { threadId: `thread-${index % 1_000}`, token: index }
  ownedRows.set(id, value)
  indexedOwnedRows.set(id, value)
}

const largeReconnectQueue = Array.from({ length: 4_096 }, (_, index) => ({
  id: `queued-${index}`,
}))
const largeReconnectActions = Array.from({ length: 256 }, (_, index) =>
  index % 2 === 0 ? `queued-${index * 16}` : `missing-${index}`,
)
const smallReconnectQueue = largeReconnectQueue.slice(0, 8)
const smallReconnectActions = ['queued-7']
const smallQueueBeforePush = largeReconnectQueue.slice(0, 8)
const smallQueueAfterPush = [...smallQueueBeforePush, { id: 'queued-new' }]
const largeQueueBeforeRemoval = largeReconnectQueue
const largeQueueAfterRemoval = largeReconnectQueue.slice(1)

function countLinearQueueHits(queue: readonly { id: string }[], ids: readonly string[]): number {
  let found = 0
  for (const id of ids) if (queue.some((item) => item.id === id)) found += 1
  return found
}

function countIndexedQueueHits(queue: readonly { id: string }[], ids: readonly string[]): number {
  const queuedIds = indexQueueItemIdsForChecks(queue, ids.length)
  let found = 0
  for (const id of ids)
    if (queuedIds ? queuedIds.has(id) : queue.some((item) => item.id === id)) found += 1
  return found
}

function legacyQueueSnapshotRemoved(
  previousItems: readonly { id: string }[],
  currentItems: readonly { id: string }[],
): boolean {
  const previous = new Set(previousItems.map((item) => item.id))
  const current = new Set(currentItems.map((item) => item.id))
  for (const id of previous) if (!current.has(id)) return true
  return false
}

function adaptiveQueueSnapshotRemoved(
  previousItems: readonly { id: string }[],
  currentItems: readonly { id: string }[],
): boolean {
  const current = indexQueueItemIdsForChecks(currentItems, previousItems.length)
  for (const item of previousItems) {
    if (current ? !current.has(item.id) : !currentItems.some((next) => next.id === item.id)) {
      return true
    }
  }
  return false
}

function legacyWorkspaceProjectActivity() {
  const unknown = sessions.some((session) => unknownQueues.has(session.id))
  const matchingActions = actions.filter((action) =>
    sessions.some((session) => session.id === action.threadId),
  )
  const queued =
    sessions.some(
      (session) =>
        session.status === 'queued' || (queueStates.get(session.id)?.items.length ?? 0) > 0,
    ) || matchingActions.length > 0
  const running = sessions.some((session) => session.running)
  return {
    running,
    queued,
    unknown,
    needsResync: unknown || matchingActions.some((action) => action.pending === 0),
  }
}

function assertActivity(activity: ReturnType<typeof workspaceProjectActivity>): void {
  if (activity.running || !activity.queued || activity.unknown || !activity.needsResync) {
    throw new Error('invalid workspace activity')
  }
}

describe('many-thread workspace idle check', () => {
  bench(
    'searches 10,000 sessions again for each of 1,000 actions',
    () => {
      assertActivity(legacyWorkspaceProjectActivity())
    },
    OPTIONS,
  )

  bench(
    'indexes 10,000 session ids once for all 1,000 actions',
    () => {
      assertActivity(workspaceProjectActivity(sessions, queueStates, unknownQueues, actions))
    },
    OPTIONS,
  )

  bench(
    'checks 10,000 idle sessions without allocating an action index',
    () => {
      const activity = workspaceProjectActivity(sessions, queueStates, unknownQueues, [])
      if (activity.running || activity.queued || activity.unknown || activity.needsResync) {
        throw new Error('invalid idle activity')
      }
    },
    OPTIONS,
  )
})

describe('many-thread reconnect project lookups', () => {
  bench(
    'searches the 10,000-session project tree for every thread',
    () => {
      let found = 0
      for (const id of lookupIds) {
        if (projects.some((project) => project.sessions.some((session) => session.id === id))) {
          found += 1
        }
      }
      if (found !== 500) throw new Error(`invalid legacy hits: ${found}`)
    },
    OPTIONS,
  )

  bench(
    'indexes the project snapshot once for every thread',
    () => {
      const index = indexWorkspaceSessions(projects)
      let found = 0
      for (const id of lookupIds) if (index.has(id)) found += 1
      if (found !== 500) throw new Error(`invalid indexed hits: ${found}`)
    },
    OPTIONS,
  )
})

describe('many-thread queue ownership lookups', () => {
  bench(
    'scans all 10,000 queue rows for one thread',
    () => {
      let found = 0
      for (const [, row] of ownedRows) if (row.threadId === 'thread-777') found += 1
      if (found !== 10) throw new Error(`invalid scan hits: ${found}`)
    },
    OPTIONS,
  )

  bench(
    'reads only one thread queue index',
    () => {
      let found = 0
      for (const _row of indexedOwnedRows.entriesForThread('thread-777')) found += 1
      if (found !== 10) throw new Error(`invalid indexed hits: ${found}`)
    },
    OPTIONS,
  )
})

describe('reconnect queue membership', () => {
  bench(
    'linearly checks 256 actions against a 4,096-item recovered queue',
    () => {
      if (countLinearQueueHits(largeReconnectQueue, largeReconnectActions) !== 128) {
        throw new Error('invalid large linear queue hits')
      }
    },
    OPTIONS,
  )

  bench(
    'adaptively indexes a 4,096-item recovered queue before checking 256 actions',
    () => {
      if (countIndexedQueueHits(largeReconnectQueue, largeReconnectActions) !== 128) {
        throw new Error('invalid large indexed queue hits')
      }
    },
    OPTIONS,
  )

  bench(
    'linearly checks one action against a normal 8-item queue',
    () => {
      if (countLinearQueueHits(smallReconnectQueue, smallReconnectActions) !== 1) {
        throw new Error('invalid small linear queue hits')
      }
    },
    OPTIONS,
  )

  bench(
    'keeps one normal 8-item queue check allocation-free',
    () => {
      if (countIndexedQueueHits(smallReconnectQueue, smallReconnectActions) !== 1) {
        throw new Error('invalid small indexed queue hits')
      }
    },
    OPTIONS,
  )
})

describe('live queue snapshot reconciliation', () => {
  bench(
    'allocates two id sets for one normal 8-item queue push',
    () => {
      if (legacyQueueSnapshotRemoved(smallQueueBeforePush, smallQueueAfterPush)) {
        throw new Error('normal queue push reported a removal')
      }
    },
    OPTIONS,
  )

  bench(
    'checks one normal 8-item queue push without allocating id sets',
    () => {
      if (adaptiveQueueSnapshotRemoved(smallQueueBeforePush, smallQueueAfterPush)) {
        throw new Error('normal queue push reported a removal')
      }
    },
    OPTIONS,
  )

  bench(
    'allocates two id sets for one 4,096-item queue removal',
    () => {
      if (!legacyQueueSnapshotRemoved(largeQueueBeforeRemoval, largeQueueAfterRemoval)) {
        throw new Error('large queue removal was missed')
      }
    },
    OPTIONS,
  )

  bench(
    'indexes only the current 4,095-item queue before removal checks',
    () => {
      if (!adaptiveQueueSnapshotRemoved(largeQueueBeforeRemoval, largeQueueAfterRemoval)) {
        throw new Error('large queue removal was missed')
      }
    },
    OPTIONS,
  )
})
