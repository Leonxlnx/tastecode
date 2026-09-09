import { bench, describe } from 'vitest'
import { emptyThread, reduce, type ThreadState } from './thread-store.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const TIMING_COUNTS = [1, 500, 1_000, 10_000] as const

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
