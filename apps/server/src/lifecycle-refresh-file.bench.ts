import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, bench, describe } from 'vitest'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

const THREAD_COUNT = 10_000
const DAY_MS = 24 * 60 * 60 * 1_000
const REFRESH_AT = 4 * DAY_MS
const benchmarkRoot = mkdtempSync(path.join(tmpdir(), 'harness-lifecycle-file-bench-'))
const seedPath = path.join(benchmarkRoot, 'seed.sqlite')
const seedStore = new Store(seedPath)
let runIndex = 0

seedStore.addProject('/lifecycle')
for (let index = 0; index < THREAD_COUNT; index += 1) {
  seedStore.addThread({
    id: `thread-${index}`,
    projectPath: '/lifecycle',
    provider: 'codex',
    title: `Thread ${index}`,
    createdAt: index,
  })
}
seedStore.close()

afterAll(() => rmSync(benchmarkRoot, { recursive: true, force: true }))

describe('file-backed many-thread lifecycle refresh', () => {
  bench(
    'auto-settles 10,000 inactive threads',
    async () => {
      const runPath = path.join(benchmarkRoot, `run-${runIndex++}.sqlite`)
      copyFileSync(seedPath, runPath)
      const store = new Store(runPath)
      const orchestrator = new Orchestrator(store, {
        onEvent: () => {},
        onLog: () => {},
        onLogin: () => {},
        mcpConfig: new McpConfigStore(path.join(benchmarkRoot, 'mcp.json')),
        runtimeFor: () => {
          throw new Error('lifecycle benchmark does not start provider runtimes')
        },
      })
      orchestrator.refreshLifecycle(REFRESH_AT)
      if (store.inactiveThreadCandidates(REFRESH_AT).length !== 0) {
        throw new Error('not every inactive thread was settled')
      }
      await orchestrator.disposeAll()
      store.close()
    },
    { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 },
  )
})
