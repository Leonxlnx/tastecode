import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  emptyThread,
  reduce,
  reduceDeltas,
  type ItemDeltaEvent,
  type ThreadState,
} from '../thread-store.js'
import { makeFixtureThread } from './fixture.js'
import { createThreadProjector, findTurns, presentTurns } from './turns.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const FAST_OPTIONS = { iterations: 1_000_000, time: 0, warmupIterations: 100_000, warmupTime: 0 }
const transcript = makeFixtureThread(1_000)

const liveItem: Item = {
  id: 'live-item',
  turnId: 'live-turn',
  type: 'message',
  role: 'assistant',
  status: 'started',
  text: '',
  createdAt: 0,
}

const streamingState: ThreadState = {
  ...emptyThread,
  items: [...transcript, liveItem],
  running: true,
  activeTurn: { id: liveItem.turnId, startedAt: 0 },
}
const streamedFrames = [streamingState.items, [...transcript, { ...liveItem, text: 'next frame' }]]
const projectThread = createThreadProjector()
projectThread(streamedFrames[0]!)
let streamedFrame = 0

const deltas: ItemDeltaEvent[] = Array.from({ length: 500 }, () => ({
  type: 'item.delta',
  turnId: liveItem.turnId,
  itemId: liveItem.id,
  textDelta: 'x',
}))

describe('long-thread hot paths', () => {
  bench(
    'derives navigation and presentation for 1,000 items',
    () => {
      findTurns(transcript)
      presentTurns(transcript)
    },
    OPTIONS,
  )

  bench(
    'projects a streamed tail update in a 1,000-item thread',
    () => {
      streamedFrame = streamedFrame === 0 ? 1 : 0
      projectThread(streamedFrames[streamedFrame]!)
    },
    FAST_OPTIONS,
  )

  bench(
    'folds 500 live deltas into a 1,000-item thread',
    () => {
      let state = streamingState
      for (const event of deltas) state = reduce(state, event)
      if (state.items.at(-1)?.text?.length !== deltas.length) throw new Error('invalid fold')
    },
    OPTIONS,
  )

  bench(
    'folds a 500-delta frame into a 1,000-item thread',
    () => {
      const state = reduceDeltas(streamingState, deltas)
      if (state.items.at(-1)?.text?.length !== deltas.length) throw new Error('invalid batch')
    },
    OPTIONS,
  )
})
