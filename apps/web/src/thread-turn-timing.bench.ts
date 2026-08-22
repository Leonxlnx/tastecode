import { bench, describe } from 'vitest'
import { emptyThread, reduce, type ThreadState } from './thread-store.js'
import {
  markTurnTimingChange,
  materializeTurnTiming,
  turnTimingKeys,
  updateTurnTiming,
} from './turn-timing-change.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const TIMING_COUNTS = [1, 1_000, 10_000] as const

function makeTiming(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `turn-${index}`,
      { startedAt: index * 2, completedAt: index * 2 + 1 },
    ]),
  )
}

const states = new Map<number, ThreadState>(
  TIMING_COUNTS.map((count) => [
    count,
    {
      ...emptyThread,
      turnTiming: makeTiming(count),
    },
  ]),
)

const longState = states.get(10_000)!
let deepestTiming = longState.turnTiming
let nearDeepestTiming = longState.turnTiming
for (let index = 0; index < 128; index += 1) {
  deepestTiming = updateTurnTiming(deepestTiming, `layer-${index}`, {
    startedAt: 20_001 + index,
  })
  if (index === 126) nearDeepestTiming = deepestTiming
}
const deepestState: ThreadState = { ...longState, turnTiming: deepestTiming }
const nearDeepestState: ThreadState = { ...longState, turnTiming: nearDeepestTiming }

function legacyStart(state: ThreadState): ThreadState {
  const turnId = 'new-turn'
  const startedAt = state.turnTiming[turnId]?.startedAt ?? 20_002
  return {
    ...state,
    running: true,
    activeTurn: { id: turnId, startedAt },
    turnTiming: markTurnTimingChange(
      { ...state.turnTiming, [turnId]: { ...state.turnTiming[turnId], startedAt } },
      turnId,
    ),
  }
}

function readRecordedTurns(state: ThreadState): number {
  let total = 0
  for (let index = 0; index < 10_000; index += 1) {
    total += state.turnTiming[`turn-${index}`]?.completedAt ?? 0
  }
  return total
}

describe('long-thread turn timing updates', () => {
  for (const count of TIMING_COUNTS) {
    bench(
      `starts a turn after ${count.toLocaleString('en-US')} recorded turns`,
      () => {
        const state = reduce(states.get(count)!, {
          type: 'turn.started',
          turn: {
            id: 'new-turn',
            threadId: 'thread-1',
            status: 'running',
            createdAt: count * 2 + 2,
          },
        })
        if (state.turnTiming['new-turn']?.startedAt === undefined) {
          throw new Error('new turn timing missing')
        }
      },
      OPTIONS,
    )

    bench(
      `completes a turn among ${count.toLocaleString('en-US')} recorded turns`,
      () => {
        const state = reduce(states.get(count)!, {
          type: 'turn.completed',
          turnId: `turn-${count - 1}`,
          status: 'completed',
          completedAt: count * 2 + 2,
        })
        if (state.turnTiming[`turn-${count - 1}`]?.completedAt !== count * 2 - 1) {
          throw new Error('durable completion timing changed')
        }
      },
      OPTIONS,
    )
  }
})

describe('bounded timing-layer costs', () => {
  bench(
    'copies all 10,000 recorded turns at turn start',
    () => {
      if (legacyStart(longState).turnTiming['new-turn']?.startedAt !== 20_002) {
        throw new Error('legacy turn timing missing')
      }
    },
    OPTIONS,
  )

  bench(
    'adds one timing layer after 10,000 recorded turns',
    () => {
      const state = reduce(longState, {
        type: 'turn.started',
        turn: {
          id: 'new-turn',
          threadId: 'thread-1',
          status: 'running',
          createdAt: 20_002,
        },
      })
      if (state.turnTiming['new-turn']?.startedAt !== 20_002) {
        throw new Error('layered turn timing missing')
      }
    },
    OPTIONS,
  )

  bench(
    'compacts 128 timing layers over 10,000 recorded turns',
    () => {
      const state = reduce(deepestState, {
        type: 'turn.started',
        turn: {
          id: 'compaction-turn',
          threadId: 'thread-1',
          status: 'running',
          createdAt: 20_200,
        },
      })
      if (state.turnTiming['turn-0']?.startedAt !== 0) {
        throw new Error('compaction lost historical timing')
      }
    },
    OPTIONS,
  )

  bench(
    'updates a 127-entry timing overlay over 10,000 recorded turns',
    () => {
      const state = reduce(nearDeepestState, {
        type: 'turn.started',
        turn: {
          id: 'deep-overlay-turn',
          threadId: 'thread-1',
          status: 'running',
          createdAt: 20_200,
        },
      })
      if (state.turnTiming['deep-overlay-turn']?.startedAt !== 20_200) {
        throw new Error('deep overlay timing missing')
      }
    },
    OPTIONS,
  )

  bench(
    'reads all 10,000 turns from a flat timing record',
    () => {
      if (readRecordedTurns(longState) === 0) throw new Error('flat timing lookup failed')
    },
    OPTIONS,
  )

  bench(
    'reads all 10,000 turns through 128 timing layers',
    () => {
      if (readRecordedTurns(deepestState) === 0) throw new Error('layered timing lookup failed')
    },
    OPTIONS,
  )

  bench(
    'materializes 128 timing layers over 10,000 recorded turns',
    () => {
      const timing = materializeTurnTiming(deepestTiming)
      if (turnTimingKeys(timing).length !== 10_128) {
        throw new Error('materialized timing count changed')
      }
    },
    OPTIONS,
  )
})
