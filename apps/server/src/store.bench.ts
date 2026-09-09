import { afterAll, bench, describe } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { compactHistoryReplay } from './history-replay.js'
import { LifecycleScheduler } from './lifecycle-scheduler.js'
import { projectHistoryItems } from './side-chat.js'
import { Store } from './store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }

function makeStore(projectCount: number, threadsPerProject: number): Store {
  const store = new Store(':memory:')
  for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
    const projectPath = `/project-${projectIndex}`
    store.addProject(projectPath)
    for (let threadIndex = 0; threadIndex < threadsPerProject; threadIndex += 1) {
      store.addThread({
        id: `thread-${projectIndex}-${threadIndex}`,
        projectPath,
        provider: 'codex',
        title: `Thread ${threadIndex}`,
        createdAt: threadIndex,
      })
    }
  }
  return store
}

const fixtures = [
  { projectCount: 1, threadsPerProject: 50, store: makeStore(1, 50) },
  { projectCount: 100, threadsPerProject: 100, store: makeStore(100, 100) },
] as const

function makeHistoryStore(): Store {
  const store = new Store(':memory:')
  store.addProject('/history')
  store.addThread({
    id: 'history-thread',
    projectPath: '/history',
    provider: 'codex',
    title: 'History',
  })
  for (let itemIndex = 0; itemIndex < 1_000; itemIndex += 1) {
    const item = {
      id: `item-${itemIndex}`,
      turnId: `turn-${itemIndex}`,
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'started' as const,
      text: '',
      createdAt: itemIndex,
    }
    store.append('history-thread', { type: 'item.started', item })
    for (let deltaIndex = 0; deltaIndex < 50; deltaIndex += 1) {
      store.append('history-thread', {
        type: 'item.delta',
        turnId: item.turnId,
        itemId: item.id,
        textDelta: 'x',
      })
    }
    store.append('history-thread', {
      type: 'item.completed',
      item: { ...item, status: 'completed', text: 'x'.repeat(50) },
    })
  }
  return store
}

const historyStore = makeHistoryStore()
const persistedHistory = historyStore.history('history-thread')
const compactedHistory = compactHistoryReplay(persistedHistory)
historyStore.saveReplaySnapshot(
  'history-thread',
  historyStore.lastSeq('history-thread'),
  compactedHistory,
)
const shortHistoryStore = new Store(':memory:')
shortHistoryStore.addProject('/short-history')
shortHistoryStore.addThread({
  id: 'short-thread',
  projectPath: '/short-history',
  provider: 'codex',
  title: 'Short history',
})
const shortSequence = shortHistoryStore.append('short-thread', {
  type: 'item.completed',
  item: {
    id: 'short-answer',
    turnId: 'short-turn',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text: 'done',
    createdAt: 1,
  },
})
shortHistoryStore.saveReplaySnapshot('short-thread', shortSequence, [
  { seq: shortSequence, event: shortHistoryStore.history('short-thread')[0]!.event },
])
const incompleteHistory = [
  {
    seq: 1,
    event: {
      type: 'item.started' as const,
      item: {
        id: 'incomplete-item',
        turnId: 'incomplete-turn',
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'started' as const,
        text: '',
        createdAt: 0,
      },
    },
  },
  ...Array.from({ length: 20_000 }, (_, index) => ({
    seq: index + 2,
    event: {
      type: 'item.delta' as const,
      turnId: 'incomplete-turn',
      itemId: 'incomplete-item',
      textDelta: 'x'.repeat(64),
    },
  })),
]
const idleLifecycleStore = fixtures[1].store
const idleLifecycleScheduler = new LifecycleScheduler(
  () => {
    idleLifecycleStore.dueSnoozedThreadIds(-1)
    idleLifecycleStore.sidebarSettings()
    idleLifecycleStore.inactiveThreadCandidates(-1)
  },
  () => idleLifecycleStore.nextLifecycleRefreshAt(),
  () => 0,
)
idleLifecycleScheduler.refreshNow()

function legacyProjectHistoryItems(history: ReadonlyArray<{ event: DomainEvent }>): Item[] {
  const order: string[] = []
  const items = new Map<string, Item>()
  for (const { event } of history) {
    if (event.type === 'item.started') {
      const existing = items.get(event.item.id)
      if (!existing) {
        order.push(event.item.id)
        items.set(event.item.id, event.item)
      } else if (existing.status === 'started' || existing.turnId === '') {
        items.set(event.item.id, {
          ...event.item,
          ...(!(event.item.text || !existing.text) ? { text: existing.text } : {}),
        })
      }
    } else if (event.type === 'item.delta') {
      const current = items.get(event.itemId)
      if (current?.status === 'started') {
        items.set(event.itemId, { ...current, text: (current.text ?? '') + event.textDelta })
      } else if (!current) {
        order.push(event.itemId)
        items.set(event.itemId, {
          id: event.itemId,
          turnId: event.turnId,
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: event.textDelta,
          createdAt: 0,
        })
      }
    } else if (event.type === 'item.completed') {
      if (!items.has(event.item.id)) order.push(event.item.id)
      const existing = items.get(event.item.id)
      items.set(event.item.id, {
        ...event.item,
        ...(!event.item.text && existing ? { text: existing.text } : {}),
      })
    }
  }
  return order.map((id) => items.get(id)).filter((item): item is Item => item !== undefined)
}

afterAll(() => {
  idleLifecycleScheduler.dispose()
  for (const fixture of fixtures) fixture.store.close()
  historyStore.close()
  shortHistoryStore.close()
})

describe('project thread listing', () => {
  for (const { projectCount, threadsPerProject, store } of fixtures) {
    const expectedThreads = projectCount * threadsPerProject
    let pinned = false
    bench(
      `lists ${expectedThreads.toLocaleString('en-US')} threads across ${projectCount} projects`,
      () => {
        let threadCount = 0
        for (const project of store.projects()) threadCount += store.threads(project.path).length
        if (threadCount !== expectedThreads) throw new Error('invalid project thread count')
      },
      OPTIONS,
    )
    bench(
      `lists ${expectedThreads.toLocaleString('en-US')} threads with one compact sidebar read`,
      () => {
        pinned = !pinned
        store.setThreadPinned('thread-0-0', pinned)
        const projects = store.projects()
        const counts = new Map(projects.map((project) => [project.path, 0]))
        for (const thread of store.sidebarThreads()) {
          const count = counts.get(thread.projectPath)
          if (count !== undefined) counts.set(thread.projectPath, count + 1)
        }
        let threadCount = 0
        for (const count of counts.values()) threadCount += count
        if (threadCount !== expectedThreads) throw new Error('invalid bulk thread count')
      },
      OPTIONS,
    )
    store.sidebarThreads()
    bench(
      `reuses ${expectedThreads.toLocaleString('en-US')} unchanged sidebar threads`,
      () => {
        if (store.sidebarThreads().length !== expectedThreads) {
          throw new Error('invalid cached sidebar thread count')
        }
      },
      OPTIONS,
    )
  }
})

describe('many-thread sidebar metadata', () => {
  const store = fixtures[1].store

  bench(
    'reads unread and queue state separately for 10,000 threads',
    () => {
      let threadCount = 0
      for (const thread of store.threads()) {
        if (!store.thread(thread.id)) throw new Error('missing thread')
        store.queuedTurns(thread.id)
        threadCount += 1
      }
      if (threadCount !== 10_000) throw new Error('invalid thread count')
    },
    OPTIONS,
  )

  bench(
    'reuses listed metadata and reads all queued thread ids once',
    () => {
      const queued = store.queuedThreadIds()
      let threadCount = 0
      for (const thread of store.threads()) {
        void thread.unread
        void queued.has(thread.id)
        threadCount += 1
      }
      if (threadCount !== 10_000) throw new Error('invalid thread count')
    },
    OPTIONS,
  )
})

describe('thread history loading', () => {
  bench(
    'validates a short replay in one read',
    () => {
      const snapshot = shortHistoryStore.tailReplaySnapshotForResponse('short-thread')
      if (snapshot?.entries.length !== 1) throw new Error('invalid short replay snapshot')
    },
    OPTIONS,
  )

  bench(
    'loads and validates 52,000 persisted events',
    () => {
      const history = historyStore.history('history-thread')
      if (history.length !== 52_000) throw new Error('invalid history event count')
    },
    OPTIONS,
  )

  bench(
    'loads and tail-validates the compact replay in one read',
    () => {
      const snapshot = historyStore.tailReplaySnapshotForResponse('history-thread')
      if (snapshot?.entries.length !== 1_000) throw new Error('invalid replay snapshot')
    },
    OPTIONS,
  )

  bench(
    'compacts 52,000 parsed events for fresh replay',
    () => {
      const history = compactHistoryReplay(persistedHistory)
      if (history.length !== 1_000) throw new Error('invalid compacted history event count')
    },
    OPTIONS,
  )

  bench(
    'legacy projection and serialization of one 20,000-delta item',
    () => {
      JSON.stringify(legacyProjectHistoryItems(incompleteHistory))
    },
    OPTIONS,
  )

  bench(
    'chunked projection and serialization of one 20,000-delta item',
    () => {
      JSON.stringify(projectHistoryItems(incompleteHistory))
    },
    OPTIONS,
  )
})

describe('idle lifecycle refresh', () => {
  bench(
    'checks compact lifecycle indexes when none are due',
    () => {
      const store = fixtures[1].store
      if (store.dueSnoozedThreadIds(-1).length !== 0) throw new Error('unexpected snoozed thread')
      if (store.inactiveThreadCandidates(-1).length !== 0) {
        throw new Error('unexpected inactive thread')
      }
    },
    OPTIONS,
  )

  bench(
    'reads the next lifecycle deadline once for one idle hour',
    () => {
      if (fixtures[1].store.nextLifecycleRefreshAt() === undefined) {
        throw new Error('missing lifecycle deadline')
      }
    },
    OPTIONS,
  )

  bench(
    'checks the cached lifecycle deadline for 120 unchanged sidebar reads',
    () => {
      for (let poll = 0; poll < 120; poll += 1) idleLifecycleScheduler.refreshIfDue()
    },
    OPTIONS,
  )
})
