import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from './thread-frame-store.js'
import {
  emptyThread,
  reduceDeltas,
  type ItemDeltaEvent,
  type LiveItemUpdate,
  type ThreadState,
} from './thread-store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }

function makeItem(index: number): Item {
  return {
    id: `item-${index}`,
    turnId: 'active-turn',
    type: 'tool_call',
    status: 'started',
    text: '',
    createdAt: index,
  }
}

function makeLiveItems(items: Item[], indices: readonly number[], version: number) {
  return new Map<number, LiveItemUpdate>(
    indices.map((index) => [
      index,
      {
        item: { ...items[index]!, text: `frame-${version}` },
        version,
        textUpdate: { kind: 'append', text: 'x' },
      },
    ]),
  )
}

function makeFrames(itemCount: number, liveCount: number): [ThreadState, ThreadState, number[]] {
  const items = Array.from({ length: itemCount }, (_, index) => makeItem(index))
  const indices = Array.from({ length: liveCount }, (_, offset) => itemCount - liveCount + offset)
  const base = {
    ...emptyThread,
    items,
    running: true,
    activeTurn: { id: 'active-turn', startedAt: 0 },
  }
  return [
    { ...base, liveItems: makeLiveItems(items, indices, 1), itemVersion: 1 },
    { ...base, liveItems: makeLiveItems(items, indices, 2), itemVersion: 2 },
    indices,
  ]
}

function publisher(itemCount: number, liveCount: number) {
  const [first, second, indices] = makeFrames(itemCount, liveCount)
  const store = new ThreadFrameStore(first)
  let frame = 0
  let notifications = 0
  store.subscribeItems(indices, () => {
    notifications += 1
  })
  return () => {
    frame = frame === 0 ? 1 : 0
    store.publish(frame === 0 ? first : second)
    if (notifications === 0) throw new Error('changed rows were not published')
  }
}

function sparseLivePublisher(itemCount: number) {
  const items = Array.from({ length: itemCount }, (_, index) => makeItem(index))
  const firstLiveItems = makeLiveItems(
    items,
    Array.from({ length: itemCount }, (_, index) => index),
    1,
  )
  const secondLiveItems = new Map(firstLiveItems)
  secondLiveItems.set(itemCount - 1, {
    item: { ...items[itemCount - 1]!, text: 'next' },
    version: 2,
    textUpdate: { kind: 'append', text: 'next' },
  })
  const base = {
    ...emptyThread,
    items,
    running: true,
    activeTurn: { id: 'active-turn', startedAt: 0 },
  }
  const frames: [ThreadState, ThreadState] = [
    { ...base, liveItems: firstLiveItems, itemVersion: 1 },
    { ...base, liveItems: secondLiveItems, itemVersion: 2 },
  ]
  const store = new ThreadFrameStore(frames[0])
  let frame = 0
  let notifications = 0
  store.subscribeItems([itemCount - 1], () => {
    notifications += 1
  })
  return () => {
    frame = frame === 0 ? 1 : 0
    store.publish(frames[frame]!)
    if (notifications === 0) throw new Error('changed row was not published')
  }
}

function reducedSparseLivePublisher(itemCount: number) {
  const items = Array.from({ length: itemCount }, (_, index) => makeItem(index))
  const indices = Array.from({ length: itemCount }, (_, index) => index)
  const base: ThreadState = {
    ...emptyThread,
    items,
    liveItems: makeLiveItems(items, indices, 1),
    itemVersion: 1,
    running: true,
    activeTurn: { id: 'active-turn', startedAt: 0 },
  }
  const delta: ItemDeltaEvent[] = [
    {
      type: 'item.delta',
      turnId: 'active-turn',
      itemId: `item-${itemCount - 1}`,
      textDelta: 'next',
    },
  ]
  return () => {
    let notifications = 0
    const store = new ThreadFrameStore(base)
    store.subscribeItems([itemCount - 1], () => {
      notifications += 1
    })
    store.publish(reduceDeltas(base, delta))
    if (notifications !== 1) throw new Error('changed row was not published once')
  }
}

function unchangedLargeOverlayStructurePublisher(itemCount: number) {
  const items = Array.from({ length: itemCount }, (_, index) => makeItem(index))
  const liveItems = makeLiveItems(
    items,
    Array.from({ length: itemCount }, (_, index) => index),
    1,
  )
  const base = {
    ...emptyThread,
    items,
    liveItems,
    itemVersion: 1,
    running: true,
    activeTurn: { id: 'active-turn', startedAt: 0 },
  }
  const frames: [ThreadState, ThreadState] = [base, { ...base, liveStart: 1 }]
  const store = new ThreadFrameStore(frames[0])
  let frame = 0
  let notifications = 0
  store.subscribeStructure(() => {
    notifications += 1
  })
  return () => {
    frame = frame === 0 ? 1 : 0
    store.publish(frames[frame]!)
    if (notifications === 0) throw new Error('structure was not published')
  }
}

const publishShort = publisher(1, 1)
const publishLong = publisher(10_000, 1)
const publishToolHeavy = publisher(10_000, 100)
const publishSparseLargeOverlay = sparseLivePublisher(10_000)
const reduceAndPublishSparseLargeOverlay = reducedSparseLivePublisher(10_000)
const publishUnchangedLargeOverlayStructure = unchangedLargeOverlayStructurePublisher(10_000)
const [, largeActivityFrame, largeActivityIndices] = makeFrames(10_000, 10_000)
const largeActivityStore = new ThreadFrameStore(largeActivityFrame)
let observedVersion = 0

function subscribeLargeActivityRowsIndividually(): void {
  const unsubscribe = largeActivityStore.subscribeItems(largeActivityIndices, () => undefined)
  unsubscribe()
}

function subscribeLargeActivityRange(): void {
  const unsubscribe = largeActivityStore.subscribeItemRange(0, 9_999, () => undefined)
  unsubscribe()
}

function scanLargeActivityVersions(): void {
  let version = 0
  for (const index of largeActivityIndices) {
    version = Math.max(version, largeActivityFrame.liveItems.get(index)?.version ?? 0)
  }
  observedVersion += version
}

function readLargeActivityFrameVersion(): void {
  observedVersion += largeActivityStore.getSnapshot().itemVersion
}

describe('active transcript frame publication', () => {
  bench('publishes one live row in a one-item thread', publishShort, OPTIONS)
  bench('publishes one live row in a 10,000-item thread', publishLong, OPTIONS)
  bench('publishes 100 live tool rows in a 10,000-item thread', publishToolHeavy, OPTIONS)
  bench(
    'publishes one changed row in a 10,000-item live overlay',
    publishSparseLargeOverlay,
    OPTIONS,
  )
  bench(
    'reduces and publishes one changed row in a 10,000-item live overlay',
    reduceAndPublishSparseLargeOverlay,
    OPTIONS,
  )
  bench(
    'publishes structure with an unchanged 10,000-item live overlay',
    publishUnchangedLargeOverlayStructure,
    OPTIONS,
  )
})

describe('large activity-group frame subscription', () => {
  bench('subscribes 10,000 activity rows individually', subscribeLargeActivityRowsIndividually, {
    time: 1_200,
    warmupTime: 300,
  })
  bench('subscribes one 10,000-row activity range', subscribeLargeActivityRange, {
    time: 1_200,
    warmupTime: 300,
  })
  bench('scans 10,000 activity versions after a frame', scanLargeActivityVersions, OPTIONS)
  bench('reads one frame version for the activity range', readLargeActivityFrameVersion, OPTIONS)
})
