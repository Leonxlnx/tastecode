import { afterAll, bench, describe } from 'vitest'
import { DomainEventSchema } from '@harness/contracts'
import { z } from 'zod'
import { Store } from './store.js'
import { createHistoryResponseProjector } from './history-response.js'
import { compactHistoryReplay } from './history-replay.js'
import { createSerializedResultCache, serializeSuccessResponse } from './response-serializer.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const SLOW_OPTIONS = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 }
const ReplaySchema = z.array(z.object({ seq: z.number().safe().int(), event: DomainEventSchema }))
const entries = Array.from({ length: 1_000 }, (_, index) => ({
  seq: index + 1,
  event: {
    type: 'item.completed' as const,
    item: {
      id: `item-${index}`,
      turnId: `turn-${index}`,
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'completed' as const,
      text: 'x'.repeat(256),
      createdAt: index,
    },
  },
}))
const payload = JSON.stringify(entries)
const store = new Store(':memory:')
store.addProject('/repo')
store.addThread({ id: 'thread', projectPath: '/repo', provider: 'codex', title: 'Thread' })
for (const entry of entries) store.append('thread', entry.event)
store.saveReplaySnapshot('thread', entries.length, entries)
const projectHistory = createHistoryResponseProjector()
const serializeHistory = createSerializedResultCache()
const retainedHistory = projectHistory(entries, false)
serializeHistory(retainedHistory)
let requestId = 0

const SWITCH_THREAD_COUNT = 16
const switchStore = new Store(':memory:')
switchStore.addProject('/switching')
const switchThreadIds = Array.from({ length: SWITCH_THREAD_COUNT }, (_, index) => `switch-${index}`)
for (const threadId of switchThreadIds) {
  switchStore.addThread({
    id: threadId,
    projectPath: '/switching',
    provider: 'codex',
    title: threadId,
  })
  const snapshot = entries.slice(0, 250).map((entry) => ({
    seq: switchStore.append(threadId, entry.event),
    event: entry.event,
  }))
  switchStore.saveReplaySnapshot(threadId, snapshot.at(-1)!.seq, snapshot)
}

const EVICTION_THREAD_COUNT = 65
const evictionStore = new Store(':memory:')
evictionStore.addProject('/eviction')
const evictionThreadIds = Array.from(
  { length: EVICTION_THREAD_COUNT },
  (_, index) => `eviction-${index}`,
)
for (const threadId of evictionThreadIds) {
  evictionStore.addThread({
    id: threadId,
    projectPath: '/eviction',
    provider: 'codex',
    title: threadId,
  })
  const snapshot = entries.slice(0, 16).map((entry) => ({
    seq: evictionStore.append(threadId, entry.event),
    event: entry.event,
  }))
  evictionStore.saveReplaySnapshot(threadId, snapshot.at(-1)!.seq, snapshot)
}

const staleStore = new Store(':memory:')
staleStore.addProject('/repo')
staleStore.addThread({ id: 'stale', projectPath: '/repo', provider: 'codex', title: 'Stale' })
for (let itemIndex = 0; itemIndex < 1_000; itemIndex += 1) {
  const item = {
    id: `streamed-${itemIndex}`,
    turnId: `turn-${itemIndex}`,
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'started' as const,
    text: '',
    createdAt: itemIndex,
  }
  staleStore.append('stale', { type: 'item.started', item })
  for (let deltaIndex = 0; deltaIndex < 50; deltaIndex += 1) {
    staleStore.append('stale', {
      type: 'item.delta',
      turnId: item.turnId,
      itemId: item.id,
      textDelta: 'x',
    })
  }
  staleStore.append('stale', {
    type: 'item.completed',
    item: { ...item, status: 'completed' },
  })
}
const staleSnapshotSeq = staleStore.lastSeq('stale')
const staleSnapshot = compactHistoryReplay(staleStore.history('stale'))
staleStore.saveReplaySnapshot('stale', staleSnapshotSeq, staleSnapshot)
for (let index = 0; index < 10; index += 1) {
  staleStore.append('stale', {
    type: 'item.completed',
    item: {
      id: `tail-${index}`,
      turnId: `tail-turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: 'tail',
      createdAt: index,
    },
  })
}

afterAll(() => {
  store.close()
  staleStore.close()
  switchStore.close()
  evictionStore.close()
})

describe('reopening one compact long-thread replay', () => {
  bench(
    'parses and validates 1,000 compact events again',
    () => {
      if (ReplaySchema.parse(JSON.parse(payload)).length !== entries.length) {
        throw new Error('invalid replay')
      }
    },
    OPTIONS,
  )

  bench(
    'reuses the parsed immutable replay',
    () => {
      if (store.tailReplaySnapshotForResponse('thread')?.entries.length !== entries.length) {
        throw new Error('invalid cached replay')
      }
    },
    OPTIONS,
  )
})

describe('switching across compact thread replays', () => {
  bench(
    'opens 16 medium threads in sequence',
    () => {
      let eventCount = 0
      for (const threadId of switchThreadIds) {
        eventCount += switchStore.tailReplaySnapshotForResponse(threadId)?.entries.length ?? 0
      }
      if (eventCount !== SWITCH_THREAD_COUNT * 250) throw new Error('invalid replay total')
    },
    OPTIONS,
  )

  bench(
    'opens 65 tiny threads across the bounded cache',
    () => {
      let eventCount = 0
      for (const threadId of evictionThreadIds) {
        eventCount += evictionStore.tailReplaySnapshotForResponse(threadId)?.entries.length ?? 0
      }
      if (eventCount !== EVICTION_THREAD_COUNT * 16) throw new Error('invalid eviction total')
    },
    OPTIONS,
  )
})

describe('encoding one unchanged compact long-thread replay', () => {
  bench(
    'walks and encodes the 1,000-event result again',
    () => {
      if (JSON.stringify({ id: '1', result: { events: entries, running: false } }).length < 1_000) {
        throw new Error('invalid response')
      }
    },
    OPTIONS,
  )

  bench(
    'reuses the encoded immutable result',
    () => {
      const response = serializeSuccessResponse(
        String((requestId += 1)),
        serializeHistory(projectHistory(entries, false)),
      )
      if (response.length < 1_000) throw new Error('invalid cached response')
    },
    OPTIONS,
  )
})

describe('reopening a long thread after a small tail', () => {
  bench(
    'parses and compacts all 52,010 persisted events',
    () => {
      if (compactHistoryReplay(staleStore.history('stale')).length !== 1_010) {
        throw new Error('invalid full replay')
      }
    },
    SLOW_OPTIONS,
  )

  bench(
    'extends the 1,000-item compact replay with 10 tail events',
    () => {
      const base = staleStore.replaySnapshotBase('stale')
      if (
        !base ||
        compactHistoryReplay([...base.entries, ...staleStore.history('stale', base.seq)]).length !==
          1_010 ||
        base.seq !== staleSnapshotSeq
      ) {
        throw new Error('invalid incremental replay')
      }
    },
    SLOW_OPTIONS,
  )
})
