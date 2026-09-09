import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, bench, describe } from 'vitest'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

const THREAD_COUNT = 10_000
const DAY_MS = 24 * 60 * 60 * 1_000
const REFRESH_AT = 4 * DAY_MS
const OPTIONS = { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 }
const SCAN_OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const benchmarkRoot = mkdtempSync(path.join(tmpdir(), 'harness-lifecycle-refresh-bench-'))
const store = new Store(':memory:')
const threadIds = Array.from({ length: THREAD_COUNT }, (_, index) => `thread-${index}`)
const warmSidebarStore = new Store(':memory:')
const snoozedStore = new Store(':memory:')
const warmSidebarThreadIds = Array.from(
  { length: THREAD_COUNT },
  (_, index) => `warm-thread-${index}`,
)
const WARM_SIDEBAR_OPTIONS = {
  iterations: 3,
  time: 0,
  warmupIterations: 1,
  warmupTime: 0,
}

store.addProject('/lifecycle')
warmSidebarStore.addProject('/lifecycle')
snoozedStore.addProject('/lifecycle')
for (let index = 0; index < THREAD_COUNT; index += 1) {
  store.addThread({
    id: threadIds[index]!,
    projectPath: '/lifecycle',
    provider: 'codex',
    title: `Thread ${index}`,
    createdAt: index,
  })
  warmSidebarStore.addThread({
    id: warmSidebarThreadIds[index]!,
    projectPath: '/lifecycle',
    provider: 'codex',
    title: `Warm thread ${index}`,
    createdAt: index,
  })
  snoozedStore.addThread({
    id: `snoozed-thread-${index}`,
    projectPath: '/lifecycle',
    provider: 'codex',
    title: `Snoozed thread ${index}`,
    createdAt: index,
  })
  snoozedStore.snoozeThread(`snoozed-thread-${index}`, REFRESH_AT, index)
}

const orchestrator = new Orchestrator(store, {
  onEvent: () => {},
  onLog: () => {},
  onLogin: () => {},
  mcpConfig: new McpConfigStore(path.join(benchmarkRoot, 'mcp.json')),
  runtimeFor: () => {
    throw new Error('lifecycle benchmark does not start provider runtimes')
  },
})
const warmSidebarOrchestrator = new Orchestrator(warmSidebarStore, {
  onEvent: () => {},
  onLog: () => {},
  onLogin: () => {},
  mcpConfig: new McpConfigStore(path.join(benchmarkRoot, 'warm-mcp.json')),
  runtimeFor: () => {
    throw new Error('lifecycle benchmark does not start provider runtimes')
  },
})
warmSidebarStore.sidebarThreads()

afterAll(async () => {
  await orchestrator.disposeAll()
  await warmSidebarOrchestrator.disposeAll()
  store.close()
  warmSidebarStore.close()
  snoozedStore.close()
  rmSync(benchmarkRoot, { recursive: true, force: true })
})

describe('many-thread lifecycle candidate scan', () => {
  bench(
    'projects 10,000 compact inactive candidates',
    () => {
      if (store.inactiveThreadCandidates(REFRESH_AT).length !== THREAD_COUNT) {
        throw new Error('missing compact inactive candidates')
      }
    },
    SCAN_OPTIONS,
  )
})

describe('many-thread snoozed candidate scan', () => {
  bench(
    'projects 10,000 compact due snoozed thread IDs',
    () => {
      if (snoozedStore.dueSnoozedThreadIds(REFRESH_AT).length !== THREAD_COUNT) {
        throw new Error('missing due snoozed thread IDs')
      }
    },
    SCAN_OPTIONS,
  )
})

describe('many-thread lifecycle refresh', () => {
  bench(
    'reactivates and auto-settles 10,000 inactive threads',
    () => {
      for (const threadId of threadIds) store.touchThread(threadId, false, 0)
      orchestrator.refreshLifecycle(REFRESH_AT)
      if (store.inactiveThreadCandidates(REFRESH_AT).length !== 0) {
        throw new Error('not every inactive thread was settled')
      }
    },
    OPTIONS,
  )
})

describe('many-thread lifecycle refresh with a warm sidebar cache', () => {
  bench(
    'reactivates and auto-settles 10,000 cached threads',
    () => {
      for (const threadId of warmSidebarThreadIds) warmSidebarStore.touchThread(threadId, false, 0)
      warmSidebarOrchestrator.refreshLifecycle(REFRESH_AT)
      if (warmSidebarStore.inactiveThreadCandidates(REFRESH_AT).length !== 0) {
        throw new Error('not every cached inactive thread was settled')
      }
    },
    WARM_SIDEBAR_OPTIONS,
  )
})
