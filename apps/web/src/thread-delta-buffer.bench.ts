import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  appendBackgroundThreadDelta,
  appendThreadDelta,
  BACKGROUND_DELTA_EVENT_LIMIT,
  drainPendingThreadDeltas,
  shouldRetainThreadTranscript,
  type PendingThreadDeltaBatch,
} from './thread-delta-buffer.js'
import { emptyThread, reduceDeltas, type ItemDeltaEvent, type ThreadState } from './thread-store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const THREAD_COUNT = 100
const DELTAS_PER_THREAD = 8
const activeThreadId = 'thread-0'

const liveItem: Item = {
  id: 'answer',
  turnId: 'turn',
  type: 'message',
  role: 'assistant',
  status: 'started',
  text: '',
  createdAt: 0,
}
const state: ThreadState = {
  ...emptyThread,
  items: [liveItem],
  running: true,
  activeTurn: { id: liveItem.turnId, startedAt: 0 },
}
const event: ItemDeltaEvent = {
  type: 'item.delta',
  turnId: liveItem.turnId,
  itemId: liveItem.id,
  textDelta: 'token',
}
const ids = Array.from({ length: THREAD_COUNT }, (_, index) => `thread-${index}`)
const partialThreadIds = new Set(ids.slice(1))
const budgetedPartialThreadIds = new Set(ids.slice(9))
const HIDDEN_DELTA_COUNT = 4_096
const hiddenDeltas = Array.from({ length: HIDDEN_DELTA_COUNT }, () => event)
const HISTORY_LOOKUP_COUNT = 100_000
const noHistoryBuffers = new Map<string, Set<number[]>>()
const SUSTAINED_THREAD_COUNT = 16
const SUSTAINED_EVENTS_PER_THREAD = BACKGROUND_DELTA_EVENT_LIMIT
const VISIBLE_FRAME_COUNT = 10_000
const BACKGROUND_APPEND_COUNT = 100_000

type CompactBatch = PendingThreadDeltaBatch

function runSustainedWindow(
  append: (
    batch: CompactBatch | undefined,
    next: ItemDeltaEvent,
  ) => CompactBatch | PendingThreadDeltaBatch,
  expectedRetainedEvents: number,
): void {
  let retainedEvents = 0
  let renderedText = 0
  for (let threadIndex = 0; threadIndex < SUSTAINED_THREAD_COUNT; threadIndex += 1) {
    let batch: CompactBatch | undefined
    for (let eventIndex = 0; eventIndex < SUSTAINED_EVENTS_PER_THREAD; eventIndex += 1) {
      batch = append(batch, event) as CompactBatch
    }
    if (!batch) throw new Error('missing sustained delta batch')
    retainedEvents += batch.events.length
    const next = reduceDeltas(state, batch.events)
    renderedText += next.liveItems.get(0)?.item.text?.length ?? 0
  }
  if (retainedEvents !== expectedRetainedEvents) throw new Error('invalid retained delta count')
  if (renderedText !== SUSTAINED_THREAD_COUNT * SUSTAINED_EVENTS_PER_THREAD * 5) {
    throw new Error('missing sustained stream text')
  }
}

function runVisibleFrames(
  append: (
    batch: CompactBatch | undefined,
    next: ItemDeltaEvent,
  ) => CompactBatch | PendingThreadDeltaBatch,
): void {
  let renderedText = 0
  for (let frame = 0; frame < VISIBLE_FRAME_COUNT; frame += 1) {
    let batch: CompactBatch | undefined
    for (let eventIndex = 0; eventIndex < DELTAS_PER_THREAD; eventIndex += 1) {
      batch = append(batch, event) as CompactBatch
    }
    if (!batch) throw new Error('missing visible delta batch')
    const next = reduceDeltas(state, batch.events)
    renderedText += next.liveItems.get(0)?.item.text?.length ?? 0
  }
  if (renderedText !== VISIBLE_FRAME_COUNT * DELTAS_PER_THREAD * 5) {
    throw new Error('missing visible stream text')
  }
}

function runBackgroundAppends(): void {
  let batch: PendingThreadDeltaBatch | undefined
  for (let index = 0; index < BACKGROUND_APPEND_COUNT; index += 1) {
    batch = appendBackgroundThreadDelta(batch, event)
  }
  if (
    batch?.events.length !== 1 ||
    batch.eventCount !== BACKGROUND_APPEND_COUNT ||
    batch.textLength !== BACKGROUND_APPEND_COUNT * event.textDelta.length
  ) {
    throw new Error('invalid background append batch')
  }
}

type DeltaFrame = {
  states: Map<string, ThreadState>
  pending: Map<string, PendingThreadDeltaBatch>
  sequences: Map<string, number>
}

function makeFrame(): DeltaFrame {
  return {
    states: new Map(ids.map((id) => [id, state])),
    pending: new Map(
      ids.map((id) => {
        let batch: PendingThreadDeltaBatch | undefined
        for (let index = 0; index < DELTAS_PER_THREAD; index += 1) {
          batch = appendThreadDelta(batch, event, index + 1)
        }
        return [id, batch!] as const
      }),
    ),
    sequences: new Map(ids.map((id) => [id, 0])),
  }
}

function makePartialAwareFrame(partialIds = partialThreadIds): DeltaFrame {
  const pending = new Map<string, PendingThreadDeltaBatch>()
  for (const id of ids) {
    if (!shouldRetainThreadTranscript(id, activeThreadId, partialIds)) continue
    let batch: PendingThreadDeltaBatch | undefined
    for (let index = 0; index < DELTAS_PER_THREAD; index += 1) {
      batch = appendThreadDelta(batch, event, index + 1)
    }
    pending.set(id, batch!)
  }
  return {
    states: new Map(ids.map((id) => [id, state])),
    pending,
    sequences: new Map(ids.map((id) => [id, 0])),
  }
}

describe('many-thread live delta scheduling', () => {
  bench(
    'legacy frame drains every streaming thread',
    () => {
      const { states, pending, sequences } = makeFrame()
      for (const threadId of pending.keys()) {
        drainPendingThreadDeltas(states, pending, sequences, threadId)
      }
    },
    OPTIONS,
  )

  bench(
    'active-only frame drains the visible thread',
    () => {
      const { states, pending, sequences } = makeFrame()
      drainPendingThreadDeltas(states, pending, sequences, activeThreadId)
    },
    OPTIONS,
  )

  bench(
    'keeps only eight background worker transcripts hot',
    () => {
      const { states, pending, sequences } = makePartialAwareFrame(budgetedPartialThreadIds)
      for (const threadId of pending.keys()) {
        drainPendingThreadDeltas(states, pending, sequences, threadId)
      }
    },
    OPTIONS,
  )

  bench(
    'does not buffer released background transcripts',
    () => {
      const { states, pending, sequences } = makePartialAwareFrame()
      drainPendingThreadDeltas(states, pending, sequences, activeThreadId)
    },
    OPTIONS,
  )
})

function foldHiddenSideChat(batchSize: number): ThreadState {
  let next = state
  for (let index = 0; index < hiddenDeltas.length; index += batchSize) {
    next = reduceDeltas(next, hiddenDeltas.slice(index, index + batchSize))
  }
  if (next.liveItems.get(0)?.item.text?.length !== event.textDelta.length * HIDDEN_DELTA_COUNT) {
    throw new Error('missing hidden Side chat text')
  }
  return next
}

describe('hidden Side chat live delta scheduling', () => {
  bench(
    'folds hidden text once per eight-delta display frame',
    () => {
      foldHiddenSideChat(8)
    },
    OPTIONS,
  )

  bench(
    'folds hidden text in bounded background batches',
    () => {
      foldHiddenSideChat(BACKGROUND_DELTA_EVENT_LIMIT)
    },
    OPTIONS,
  )
})

describe('sixteen sustained background streams', () => {
  bench(
    'retains every same-item delta until the bounded drain',
    () => {
      runSustainedWindow(
        (batch, next) => appendThreadDelta(batch, next),
        SUSTAINED_THREAD_COUNT * SUSTAINED_EVENTS_PER_THREAD,
      )
    },
    OPTIONS,
  )

  bench(
    'retains one coalesced delta per stream until the bounded drain',
    () => {
      runSustainedWindow(
        (batch, next) => appendBackgroundThreadDelta(batch, next),
        SUSTAINED_THREAD_COUNT,
      )
    },
    OPTIONS,
  )
})

describe('steady hidden same-item buffering', () => {
  bench('coalesces 100,000 adjacent deltas', runBackgroundAppends, {
    time: 1_200,
    warmupTime: 300,
  })
})

describe('normal visible stream frames', () => {
  bench(
    'retains eight same-item deltas until the display frame',
    () => runVisibleFrames((batch, next) => appendThreadDelta(batch, next)),
    { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 },
  )

  bench(
    'retains one coalesced delta until the display frame',
    () => runVisibleFrames((batch, next) => appendBackgroundThreadDelta(batch, next)),
    { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 },
  )
})

describe('normal live delta history fan-out', () => {
  bench(
    'iterates a fallback collection when no history load exists',
    () => {
      let visited = 0
      for (let index = 0; index < HISTORY_LOOKUP_COUNT; index += 1) {
        for (const buffer of noHistoryBuffers.get(ids[index % ids.length]!) ?? []) {
          visited += buffer.length
        }
      }
      if (visited !== 0) throw new Error('unexpected history buffer')
    },
    OPTIONS,
  )

  bench(
    'skips fan-out when no history load exists',
    () => {
      let visited = 0
      for (let index = 0; index < HISTORY_LOOKUP_COUNT; index += 1) {
        const buffers = noHistoryBuffers.get(ids[index % ids.length]!)
        if (buffers) {
          for (const buffer of buffers) visited += buffer.length
        }
      }
      if (visited !== 0) throw new Error('unexpected history buffer')
    },
    OPTIONS,
  )
})
