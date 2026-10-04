import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, bench, describe } from 'vitest'
import { Store } from './store.js'

const IN_MEMORY_OPTIONS = {
  iterations: 7,
  time: 0,
  warmupIterations: 2,
  warmupTime: 0,
}
const FILE_OPTIONS = {
  iterations: 5,
  time: 0,
  warmupIterations: 1,
  warmupTime: 0,
}
const benchmarkDirectory = mkdtempSync(path.join(tmpdir(), 'harness-store-write-'))
let databaseIndex = 0

const delta = {
  type: 'item.delta' as const,
  turnId: 'turn-1',
  itemId: 'item-1',
  textDelta: 'streamed output',
}

function writeEvents(location: string, count: number): void {
  const store = new Store(location)
  store.addProject('/benchmark')
  store.addThread({
    id: 'thread-1',
    projectPath: '/benchmark',
    provider: 'codex',
    title: 'Write benchmark',
  })
  for (let index = 0; index < count; index += 1) store.append('thread-1', delta)
  if (store.lastSeq('thread-1') !== count) throw new Error('invalid persisted event count')
  store.close()
}

function writeEventsWithSerializedPayloads(location: string, count: number): void {
  const store = new Store(location)
  store.addProject('/benchmark')
  store.addThread({
    id: 'thread-1',
    projectPath: '/benchmark',
    provider: 'codex',
    title: 'Serialized write benchmark',
  })
  let serializedBytes = 0
  for (let index = 0; index < count; index += 1) {
    serializedBytes += store.appendWithSerializedEvent('thread-1', delta).serializedEvent.length
  }
  if (store.lastSeq('thread-1') !== count || serializedBytes === 0) {
    throw new Error('invalid serialized event count')
  }
  store.close()
}

function writeEventsBatchedWithSerializedPayloads(location: string, count: number): void {
  const store = new Store(location)
  store.addProject('/benchmark')
  store.addThread({
    id: 'thread-1',
    projectPath: '/benchmark',
    provider: 'codex',
    title: 'Serialized batch write benchmark',
  })
  const batchSize = 1_000
  let serializedBytes = 0
  for (let offset = 0; offset < count; offset += batchSize) {
    for (const result of store.appendBatchWithSerializedEvents(
      Array.from({ length: Math.min(batchSize, count - offset) }, () => ({
        threadId: 'thread-1',
        event: delta,
      })),
    )) {
      serializedBytes += result.serializedEvent.length
    }
  }
  if (store.lastSeq('thread-1') !== count || serializedBytes === 0) {
    throw new Error('invalid serialized batch event count')
  }
  store.close()
}

function updateActiveThread(count: number): void {
  const store = new Store(':memory:')
  store.addProject('/benchmark')
  store.addThread({
    id: 'thread-1',
    projectPath: '/benchmark',
    provider: 'codex',
    title: 'Lifecycle write benchmark',
  })
  for (let index = 0; index < count; index += 1) {
    store.touchThread('thread-1', false, index)
  }
  if (store.thread('thread-1')?.lastActiveAt !== count - 1) {
    throw new Error('invalid active timestamp')
  }
  store.close()
}

function activateThread(count: number): void {
  const store = new Store(':memory:')
  store.addProject('/benchmark')
  store.addThread({
    id: 'thread-1',
    projectPath: '/benchmark',
    provider: 'codex',
    title: 'Lifecycle activation benchmark',
  })
  for (let index = 0; index < count; index += 1) store.activateThread('thread-1', index)
  if (store.thread('thread-1')?.lifecycle.state !== 'active') {
    throw new Error('invalid active lifecycle')
  }
  store.close()
}

afterAll(() => rmSync(benchmarkDirectory, { recursive: true, force: true }))

describe('streamed event persistence', () => {
  bench(
    'persists 20,000 in-memory text deltas',
    () => writeEvents(':memory:', 20_000),
    IN_MEMORY_OPTIONS,
  )

  bench(
    'persists and retains 20,000 serialized in-memory text deltas',
    () => writeEventsWithSerializedPayloads(':memory:', 20_000),
    IN_MEMORY_OPTIONS,
  )

  bench(
    'persists and retains 20,000 serialized deltas in shared windows',
    () => writeEventsBatchedWithSerializedPayloads(':memory:', 20_000),
    IN_MEMORY_OPTIONS,
  )

  bench(
    'persists 10,000 file-backed text deltas',
    () => {
      const location = path.join(benchmarkDirectory, `events-${databaseIndex++}.sqlite`)
      writeEvents(location, 10_000)
    },
    FILE_OPTIONS,
  )

  bench(
    'updates one active thread 10,000 times',
    () => updateActiveThread(10_000),
    IN_MEMORY_OPTIONS,
  )

  bench('activates one thread 10,000 times', () => activateThread(10_000), IN_MEMORY_OPTIONS)
})
