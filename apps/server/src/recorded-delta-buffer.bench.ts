import { bench, describe } from 'vitest'
import { RecordedDeltaBuffer } from './recorded-delta-buffer.js'
import { Store } from './store.js'

const OPTIONS = {
  iterations: 7,
  time: 0,
  warmupIterations: 2,
  warmupTime: 0,
}
const EVENT_COUNT = 20_000
const AGGREGATION_EVENT_COUNT = 100_000
const AGGREGATION_TEXT_LIMIT = 64 * 1024
const STREAMING_THREAD_COUNT = 1_000
const SINGLETON_FLUSH_COUNT = 100_000
const SERIALIZATION_COUNT = 10_000
const delta = {
  type: 'item.delta' as const,
  turnId: 'turn-1',
  itemId: 'item-1',
  textDelta: 'x',
}
const largeDelta = { ...delta, textDelta: 'quote " and newline\n'.repeat(1_024) }
const threadIdJson = JSON.stringify('thread-1')
const pendingWindow = new Map(
  Array.from(
    { length: STREAMING_THREAD_COUNT },
    (_, index) =>
      [`thread-${index}`, { turnId: 'turn-1', itemId: 'item-1', chunks: ['one', 'two'] }] as const,
  ),
)
const singletonWindow = new Map([['thread-1', { turnId: 'turn-1', itemId: 'item-1', text: 'one' }]])
let projectedTextLength = 0

function aggregateWithChunkArrays(): void {
  let chunks: string[] = []
  let textLength = 0
  let eventCount = 0
  for (let index = 0; index < AGGREGATION_EVENT_COUNT; index += 1) {
    chunks.push(delta.textDelta)
    textLength += delta.textDelta.length
    eventCount += 1
    if (textLength < AGGREGATION_TEXT_LIMIT && eventCount < 256) continue
    projectedTextLength += JSON.stringify({ ...delta, textDelta: chunks.join('') }).length
    chunks = []
    textLength = 0
    eventCount = 0
  }
  if (eventCount > 0) {
    projectedTextLength += JSON.stringify({ ...delta, textDelta: chunks.join('') }).length
  }
}

function aggregateWithBoundedStrings(): void {
  let text = ''
  let eventCount = 0
  for (let index = 0; index < AGGREGATION_EVENT_COUNT; index += 1) {
    text += delta.textDelta
    eventCount += 1
    if (text.length < AGGREGATION_TEXT_LIMIT && eventCount < 256) continue
    projectedTextLength += JSON.stringify({ ...delta, textDelta: text }).length
    text = ''
    eventCount = 0
  }
  if (eventCount > 0) {
    projectedTextLength += JSON.stringify({ ...delta, textDelta: text }).length
  }
}

function makeStore(): Store {
  const store = new Store(':memory:')
  store.addProject('/benchmark')
  store.addThread({
    id: 'thread-1',
    projectPath: '/benchmark',
    provider: 'codex',
    title: 'Delta batching benchmark',
  })
  return store
}

function persistDirectly(): void {
  const store = makeStore()
  let serializedBytes = 0
  for (let index = 0; index < EVENT_COUNT; index += 1) {
    const seq = store.append('thread-1', delta)
    serializedBytes += JSON.stringify({ threadId: 'thread-1', event: delta, seq }).length
  }
  if (store.lastSeq('thread-1') !== EVENT_COUNT || serializedBytes === 0) {
    throw new Error('invalid direct event stream')
  }
  store.close()
}

function persistInBatches(): void {
  const store = makeStore()
  let serializedBytes = 0
  const buffer = new RecordedDeltaBuffer(
    (threadId, event) => {
      const seq = store.append(threadId, event)
      serializedBytes += JSON.stringify({ threadId, event, seq }).length
    },
    { delayMs: 60_000 },
  )
  for (let index = 0; index < EVENT_COUNT; index += 1) buffer.push('thread-1', delta)
  buffer.flushAll()
  const expectedEvents = Math.ceil(EVENT_COUNT / 256)
  if (store.lastSeq('thread-1') !== expectedEvents || serializedBytes === 0) {
    throw new Error('invalid batched event stream')
  }
  store.close()
}

function serializePersistedAndPushPayloadSeparately(): void {
  for (let seq = 1; seq <= SERIALIZATION_COUNT; seq += 1) {
    projectedTextLength += JSON.stringify(largeDelta).length
    projectedTextLength += JSON.stringify({ threadId: 'thread-1', event: largeDelta, seq }).length
  }
}

function reusePersistedPayloadForPush(): void {
  for (let seq = 1; seq <= SERIALIZATION_COUNT; seq += 1) {
    const eventJson = JSON.stringify(largeDelta)
    projectedTextLength += eventJson.length
    projectedTextLength += `{"threadId":${threadIdJson},"event":${eventJson},"seq":${seq}}`.length
  }
}

class PerThreadTimerBuffer {
  readonly #pending = new Map<
    string,
    {
      chunks: string[]
      textLength: number
      eventCount: number
      timer: ReturnType<typeof setTimeout>
    }
  >()

  push(threadId: string): void {
    let pending = this.#pending.get(threadId)
    if (!pending) {
      pending = {
        chunks: [],
        textLength: 0,
        eventCount: 0,
        timer: setTimeout(() => undefined, 60_000),
      }
      this.#pending.set(threadId, pending)
    }
    pending.chunks.push(delta.textDelta)
    pending.textLength += delta.textDelta.length
    pending.eventCount += 1
  }

  discardAll(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer)
    this.#pending.clear()
  }
}

function schedulePerThreadTimers(): void {
  const buffer = new PerThreadTimerBuffer()
  for (let index = 0; index < STREAMING_THREAD_COUNT; index += 1) {
    buffer.push(`thread-${index}`)
  }
  buffer.discardAll()
}

function scheduleSharedTimer(): void {
  const buffer = new RecordedDeltaBuffer(() => undefined, { delayMs: 60_000 })
  for (let index = 0; index < STREAMING_THREAD_COUNT; index += 1) {
    buffer.push(`thread-${index}`, delta)
  }
  buffer.discardAll()
}

function projectWindowWithEntryCopy(): void {
  const entries = [...pendingWindow]
  const records = entries.map(([threadId, pending]) => ({
    threadId,
    event: { ...delta, textDelta: pending.chunks.join('') },
  }))
  projectedTextLength += records[0]?.event.textDelta.length ?? 0
}

function projectWindowOnce(): void {
  const records: Array<{ threadId: string; event: typeof delta }> = []
  for (const [threadId, pending] of pendingWindow) {
    records.push({ threadId, event: { ...delta, textDelta: pending.chunks.join('') } })
  }
  projectedTextLength += records[0]?.event.textDelta.length ?? 0
}

function projectSingletonThroughBatch(): void {
  for (let index = 0; index < SINGLETON_FLUSH_COUNT; index += 1) {
    const records: Array<{ threadId: string; event: typeof delta }> = []
    for (const [threadId, pending] of singletonWindow) {
      records.push({ threadId, event: { ...delta, textDelta: pending.text } })
    }
    projectedTextLength += records[0]?.event.textDelta.length ?? 0
  }
}

function projectSingletonDirectly(): void {
  for (let index = 0; index < SINGLETON_FLUSH_COUNT; index += 1) {
    const entry = singletonWindow.entries().next().value
    if (!entry) return
    const [threadId, pending] = entry
    const record = { threadId, event: { ...delta, textDelta: pending.text } }
    projectedTextLength += record.event.textDelta.length
  }
}

describe('streamed delta persistence and broadcast serialization', () => {
  bench('writes 20,000 provider deltas directly', persistDirectly, OPTIONS)
  bench('writes 20,000 provider deltas in bounded batches', persistInBatches, OPTIONS)
})

describe('coalesced delta JSON encoding', () => {
  bench(
    'encodes the persisted event and push payload separately',
    serializePersistedAndPushPayloadSeparately,
    OPTIONS,
  )
  bench(
    'reuses the persisted event JSON in the push payload',
    reusePersistedPayloadForPush,
    OPTIONS,
  )
})

describe('streamed delta text aggregation', () => {
  bench('retains each provider fragment in a chunk array', aggregateWithChunkArrays, {
    time: 1_200,
    warmupTime: 300,
  })
  bench('extends one bounded coalesced string', aggregateWithBoundedStrings, {
    time: 1_200,
    warmupTime: 300,
  })
})

describe('many-thread delta scheduling', () => {
  bench('schedules one timer per 1,000 streaming threads', schedulePerThreadTimers, {
    time: 1_200,
    warmupTime: 300,
  })
  bench('shares one timer across 1,000 streaming threads', scheduleSharedTimer, {
    time: 1_200,
    warmupTime: 300,
  })
})

describe('many-thread delta window flush', () => {
  bench('copies 1,000 map entries before projecting the batch', projectWindowWithEntryCopy, {
    time: 1_200,
    warmupTime: 300,
  })
  bench('projects 1,000 pending deltas in one pass', projectWindowOnce, {
    time: 1_200,
    warmupTime: 300,
  })
})

describe('single-thread delta window flush', () => {
  bench('projects one pending stream through a records array', projectSingletonThroughBatch, {
    time: 1_200,
    warmupTime: 300,
  })
  bench('commits the only pending stream directly', projectSingletonDirectly, {
    time: 1_200,
    warmupTime: 300,
  })
})
