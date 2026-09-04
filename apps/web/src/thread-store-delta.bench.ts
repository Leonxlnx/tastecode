import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  emptyThread,
  reduceDeltas,
  threadItemAt,
  threadItemById,
  type ItemDeltaEvent,
  type ThreadState,
} from './thread-store.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const FRAME_COUNT = 10_000
const SUSTAINED_LARGE_FRAME_COUNT = 256
const live: Item = {
  id: 'live',
  turnId: 'active',
  type: 'message',
  role: 'assistant',
  status: 'started',
  text: '',
  createdAt: 10_000,
}
const state: ThreadState = {
  ...emptyThread,
  items: [
    ...Array.from({ length: 10_000 }, (_, index): Item => ({
      id: `history-${index}`,
      turnId: `turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: 'done',
      createdAt: index,
    })),
    live,
  ],
  running: true,
  activeTurn: { id: 'active', startedAt: 10_000 },
  liveStart: 10_000,
}
const deltas: ItemDeltaEvent[] = Array.from({ length: 8 }, () => ({
  type: 'item.delta',
  turnId: 'active',
  itemId: 'live',
  textDelta: 'token',
}))
const multiState: ThreadState = {
  ...emptyThread,
  items: Array.from({ length: 10_000 }, (_, index): Item => ({
    id: `activity-${index}`,
    turnId: 'active',
    type: 'tool_call',
    status: 'started',
    text: '',
    createdAt: index,
  })),
  running: true,
  activeTurn: { id: 'active', startedAt: 0 },
}
const multiDeltas: ItemDeltaEvent[] = [
  {
    type: 'item.delta',
    turnId: 'active',
    itemId: 'activity-0',
    textDelta: 'first',
  },
  {
    type: 'item.delta',
    turnId: 'active',
    itemId: 'activity-9999',
    textDelta: 'last',
  },
]
threadItemById(multiState, 'activity-0')
const largeLiveState: ThreadState = {
  ...multiState,
  liveItems: new Map(
    multiState.items.map((item, index) => [
      index,
      {
        item: { ...item, text: 'current' },
        version: 1,
        textUpdate: { kind: 'append' as const, text: 'current' },
      },
    ]),
  ),
  itemVersion: 1,
}
const largeLiveDelta: ItemDeltaEvent[] = [
  {
    type: 'item.delta',
    turnId: 'active',
    itemId: 'activity-9999',
    textDelta: ' next',
  },
]
const staleState: ThreadState = {
  ...state,
  liveItems: new Map([
    [
      10_000,
      {
        item: { ...live, text: 'current' },
        version: 1,
        textUpdate: { kind: 'append', text: 'current' },
      },
    ],
  ]),
  liveStart: 10_000,
}
const staleDeltas: ItemDeltaEvent[] = [
  {
    type: 'item.delta',
    turnId: 'old',
    itemId: 'history-0',
    textDelta: 'stale',
  },
  {
    type: 'item.delta',
    turnId: 'old',
    itemId: 'history-1',
    textDelta: 'stale',
  },
]
const missingDeltas: ItemDeltaEvent[] = Array.from({ length: 32 }, (_, index) => ({
  type: 'item.delta',
  turnId: 'active',
  itemId: `missing-${index}`,
  textDelta: 'first output',
}))

function legacyReduceDeltas(state: ThreadState, deltas: ItemDeltaEvent[]): ThreadState {
  const chunksByItem = new Map<string, { chunks: string[]; turnId: string }>()
  for (const event of deltas) {
    const entry = chunksByItem.get(event.itemId)
    if (entry) entry.chunks.push(event.textDelta)
    else chunksByItem.set(event.itemId, { chunks: [event.textDelta], turnId: event.turnId })
  }

  const liveItems = new Map(state.liveItems)
  let changed = false
  for (const [itemId, { chunks }] of chunksByItem) {
    const last = state.items.length - 1
    let index =
      last >= state.liveStart && threadItemAt(state.items, liveItems, last)?.id === itemId
        ? last
        : -1
    for (let candidate = last - 1; index < 0 && candidate >= state.liveStart; candidate -= 1) {
      if (threadItemAt(state.items, liveItems, candidate)?.id === itemId) index = candidate
    }
    const textDelta = chunks.length === 1 ? chunks[0]! : chunks.join('')
    const existing = threadItemAt(state.items, liveItems, index)
    if (existing?.status !== 'started') continue
    liveItems.set(index, {
      item: { ...existing, text: (existing.text ?? '') + textDelta },
      version: state.itemVersion + 1,
      textUpdate: { kind: 'append', text: textDelta },
    })
    changed = true
  }
  return changed ? { ...state, liveItems, itemVersion: state.itemVersion + 1 } : state
}

function runFrames(reducer: (state: ThreadState, deltas: ItemDeltaEvent[]) => ThreadState): void {
  let length = 0
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const next = reducer(state, deltas)
    length += threadItemAt(next.items, next.liveItems, 10_000)?.text?.length ?? 0
  }
  if (length !== FRAME_COUNT * 40) throw new Error('missing streamed text')
}

function runSustainedLargeFrames(
  reducer: (state: ThreadState, deltas: ItemDeltaEvent[]) => ThreadState,
): void {
  let current = largeLiveState
  for (let frame = 0; frame < SUSTAINED_LARGE_FRAME_COUNT; frame += 1) {
    current = reducer(current, largeLiveDelta)
  }
  if (
    threadItemAt(current.items, current.liveItems, 9_999)?.text !==
    `current${' next'.repeat(SUSTAINED_LARGE_FRAME_COUNT)}`
  ) {
    throw new Error('missing sustained live item updates')
  }
}

describe('single-item renderer delta frames', () => {
  bench('groups every frame through a map', () => runFrames(legacyReduceDeltas), OPTIONS)
  bench('coalesces the common frame directly', () => runFrames(reduceDeltas), OPTIONS)
})

describe('multi-item renderer delta frames', () => {
  bench(
    'scans a 10,000-item active turn for interleaved targets',
    () => {
      const next = legacyReduceDeltas(multiState, multiDeltas)
      if (threadItemAt(next.items, next.liveItems, 0)?.text !== 'first') {
        throw new Error('missing first activity')
      }
    },
    OPTIONS,
  )

  bench(
    'uses retained indices for interleaved targets',
    () => {
      const next = reduceDeltas(multiState, multiDeltas)
      if (threadItemAt(next.items, next.liveItems, 0)?.text !== 'first') {
        throw new Error('missing first activity')
      }
    },
    OPTIONS,
  )
})

describe('large live overlay delta frames', () => {
  bench(
    'updates one of 10,000 live items',
    () => {
      const next = reduceDeltas(largeLiveState, largeLiveDelta)
      if (threadItemAt(next.items, next.liveItems, 9_999)?.text !== 'current next') {
        throw new Error('missing live item update')
      }
    },
    { time: 1_200, warmupTime: 300 },
  )

  bench(
    'copies 10,000 live items through 256 frames',
    () => runSustainedLargeFrames(legacyReduceDeltas),
    { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 },
  )

  bench(
    'bounds the immutable overlay through 256 frames',
    () => runSustainedLargeFrames(reduceDeltas),
    { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 },
  )
})

describe('stale multi-item renderer delta frames', () => {
  bench(
    'copies the live overlay before rejecting stale targets',
    () => {
      if (legacyReduceDeltas(staleState, staleDeltas) !== staleState) {
        throw new Error('legacy stale frame changed')
      }
    },
    OPTIONS,
  )

  bench(
    'rejects stale targets before copying the live overlay',
    () => {
      if (reduceDeltas(staleState, staleDeltas) !== staleState) {
        throw new Error('stale frame changed')
      }
    },
    OPTIONS,
  )
})

describe('early multi-item renderer delta frames', () => {
  bench(
    'recovers 32 missing items in a 10,000-item thread',
    () => {
      const next = reduceDeltas(state, missingDeltas)
      if (next.items.length !== state.items.length + missingDeltas.length) {
        throw new Error('missing early activity')
      }
    },
    OPTIONS,
  )
})
