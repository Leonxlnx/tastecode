import { bench, describe } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import { emptyThread, reduce, type ThreadState } from '../thread-store.js'
import { makeFixtureThread } from './fixture.js'
import { findTurns, presentTurns } from './turns.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
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

const deltas: DomainEvent[] = Array.from({ length: 500 }, () => ({
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
    'folds 500 live deltas into a 1,000-item thread',
    () => {
      let state = streamingState
      for (const event of deltas) state = reduce(state, event)
      if (state.items.at(-1)?.text?.length !== deltas.length) throw new Error('invalid fold')
    },
    OPTIONS,
  )
})
