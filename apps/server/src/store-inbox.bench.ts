import { bench, describe } from 'vitest'
import {
  applyInboxProjectionEvent,
  emptyInboxProjection,
  type InboxProjection,
} from './inbox-projection.js'
import { Store } from './store.js'

const OPTIONS = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 }
const THREAD_COUNT = 1_000
const DELTAS_PER_THREAD = 100
const TURNS_PER_THREAD = 100
const IDLE_PROJECTION_COUNT = 100_000
const store = new Store(':memory:')
const threadIds: string[] = []

store.addProject('/benchmark')
for (let threadIndex = 0; threadIndex < THREAD_COUNT; threadIndex += 1) {
  const threadId = `thread-${threadIndex}`
  threadIds.push(threadId)
  store.addThread({
    id: threadId,
    projectPath: '/benchmark',
    provider: 'codex',
    title: `Thread ${threadIndex}`,
  })
  for (let eventIndex = 0; eventIndex < DELTAS_PER_THREAD; eventIndex += 1) {
    store.append(threadId, {
      type: 'item.delta',
      turnId: `turn-${threadIndex}`,
      itemId: `item-${threadIndex}`,
      textDelta: 'x',
    })
  }
  for (let turnIndex = 0; turnIndex < TURNS_PER_THREAD; turnIndex += 1) {
    store.append(threadId, {
      type: 'turn.completed',
      turnId: `turn-${threadIndex}-${turnIndex}`,
      status: 'completed',
    })
  }
  if (threadIndex % 10 === 0) {
    store.append(threadId, { type: 'thread.error', threadId, message: 'failed' })
  }
}

function legacyInboxProjections(): Map<string, InboxProjection> {
  const projections = new Map<string, InboxProjection>()
  for (const threadId of threadIds) {
    const projection = emptyInboxProjection()
    for (const { event } of store.history(threadId)) applyInboxProjectionEvent(projection, event)
    projections.set(threadId, projection)
  }
  return projections
}

function assertProjections(projections: Map<string, InboxProjection>, expectedSize: number): void {
  let failed = 0
  for (const projection of projections.values()) {
    if (projection.last === 'failed') failed += 1
  }
  if (projections.size !== expectedSize || failed !== THREAD_COUNT / 10) {
    throw new Error('invalid inbox projections')
  }
}

describe('many-thread sidebar status initialization', () => {
  bench(
    'replays 200 events in each of 1,000 threads',
    () => assertProjections(legacyInboxProjections(), THREAD_COUNT),
    OPTIONS,
  )
  bench(
    'reads only the 100 materialized current inbox rows',
    () => assertProjections(store.inboxProjections(), THREAD_COUNT / 10),
    OPTIONS,
  )
})

describe('idle many-thread projection allocation', () => {
  bench(
    'allocates two empty sets for 100,000 idle threads',
    () => {
      const projections = Array.from({ length: IDLE_PROJECTION_COUNT }, () => ({
        approvals: new Set<string>(),
        inputs: new Set<string>(),
        last: 'idle' as const,
      }))
      if (projections.length !== IDLE_PROJECTION_COUNT) throw new Error('missing projections')
    },
    OPTIONS,
  )
  bench(
    'keeps 100,000 idle projections allocation-light',
    () => {
      const projections = Array.from({ length: IDLE_PROJECTION_COUNT }, () =>
        emptyInboxProjection(),
      )
      if (projections.length !== IDLE_PROJECTION_COUNT) throw new Error('missing projections')
    },
    OPTIONS,
  )
})
