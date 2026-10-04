import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { createProjectListProjector, type ProjectListState } from './project-list.js'
import { createSerializedResultCache, serializeSuccessResponse } from './response-serializer.js'
import { Store } from './store.js'

const THREAD_COUNT = 10_000
const PROJECT_COUNT = 100
const RUNS = 7

type Stage =
  | 'store'
  | 'recovery'
  | 'projects'
  | 'sidebar'
  | 'objectRows'
  | 'arrayRows'
  | 'queues'
  | 'projection'
  | 'serialization'
  | 'compressionLevel1'
  | 'compressionLevel3'
  | 'compressionLevel6'

const samples = new Map<Stage, number[]>()
const root = mkdtempSync(path.join(tmpdir(), 'harness-startup-many-thread-profile-'))
const database = path.join(root, 'tastecode.db')
const seed = new Store(database)
const projectPaths = Array.from(
  { length: PROJECT_COUNT },
  (_, index) => `/startup-profile/project-${index}`,
)

for (const projectPath of projectPaths) seed.addProject(projectPath)
for (let index = 0; index < THREAD_COUNT; index += 1) {
  seed.addThread({
    id: `startup-profile-thread-${index}`,
    projectPath: projectPaths[index % projectPaths.length]!,
    provider: 'codex',
    title: `Startup profile thread ${index}`,
  })
}
seed.close()

const comparison = new DatabaseSync(database, { readOnly: true })
const sidebarSql = `SELECT id, project_path, provider, agent, title, pinned, created_at, closed_at,
                            worktree_branch, lifecycle_state, lifecycle_at, lifecycle_reason,
                            wake_at, keep_active, woke_at, unread
                     FROM threads WHERE ephemeral = 0 ORDER BY created_at DESC`
const objectRows = comparison.prepare(sidebarSql)
const arrayRows = comparison.prepare(sidebarSql)
arrayRows.setReturnArrays(true)

function measure<T>(stage: Stage, operation: () => T): T {
  const startedAt = performance.now()
  const result = operation()
  const elapsed = performance.now() - startedAt
  const stageSamples = samples.get(stage) ?? []
  stageSamples.push(elapsed)
  samples.set(stage, stageSamples)
  return result
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

const state: ProjectListState = {
  isTurnRunning: () => false,
  inboxStatus: () => 'idle',
  revision: () => 0,
}
let responseBytes = 0
let compressedBytes = { level1: 0, level3: 0, level6: 0 }

try {
  for (let run = 0; run < RUNS; run += 1) {
    measure('objectRows', () => objectRows.all())
    measure('arrayRows', () => arrayRows.all())
    const store = measure('store', () => new Store(database))
    measure('recovery', () => store.recoverInterruptedThreads())
    const projects = measure('projects', () => store.projects())
    const threads = measure('sidebar', () => store.sidebarThreads())
    const queues = measure('queues', () => store.queuedThreadIds())
    const projector = createProjectListProjector({
      includeDefaults: process.env['HARNESS_PROJECT_LIST_INCLUDE_DEFAULTS'] === '1',
    })
    const projectList = measure('projection', () => projector(projects, threads, queues, state))
    const serialize = createSerializedResultCache()
    const response = measure('serialization', () =>
      serializeSuccessResponse('1', serialize(projectList)),
    )
    const compressedLevel1 = measure('compressionLevel1', () =>
      deflateRawSync(response, { level: 1 }),
    )
    const compressedLevel3 = measure('compressionLevel3', () =>
      deflateRawSync(response, { level: 3 }),
    )
    const compressedLevel6 = measure('compressionLevel6', () =>
      deflateRawSync(response, { level: 6 }),
    )
    responseBytes = response.length
    compressedBytes = {
      level1: compressedLevel1.byteLength,
      level3: compressedLevel3.byteLength,
      level6: compressedLevel6.byteLength,
    }
    if (response.length < 1_000_000) throw new Error('profile response is unexpectedly small')
    store.close()
  }

  for (const [stage, values] of samples) {
    console.log(`${stage}: ${median(values).toFixed(3)}ms`)
  }
  console.log(
    `response: ${responseBytes} bytes -> level 1 ${compressedBytes.level1} (${((compressedBytes.level1 / responseBytes) * 100).toFixed(1)}%), level 3 ${compressedBytes.level3} (${((compressedBytes.level3 / responseBytes) * 100).toFixed(1)}%), level 6 ${compressedBytes.level6} (${((compressedBytes.level6 / responseBytes) * 100).toFixed(1)}%)`,
  )
} finally {
  comparison.close()
  rmSync(root, { recursive: true, force: true })
}
