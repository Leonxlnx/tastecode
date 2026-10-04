import type { DomainEvent } from '@harness/contracts'
import { bench, describe } from 'vitest'
import { emptyThread, reduce, reduceEventLog, type ThreadState } from './thread-store.js'

const OPTIONS = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 }
const REPLAY_OPTIONS = { iterations: 50, time: 0, warmupIterations: 10, warmupTime: 0 }
const TURN_COUNT = 5_000
const entries: Array<{ seq: number; event: DomainEvent }> = []
for (let index = 0; index < TURN_COUNT; index += 1) {
  const turnId = `turn-${index}`
  entries.push(
    {
      seq: entries.length + 1,
      event: {
        type: 'turn.started',
        turn: { id: turnId, threadId: 'thread-1', status: 'running', createdAt: index * 2 },
      },
    },
    {
      seq: entries.length + 2,
      event: {
        type: 'turn.completed',
        turnId,
        status: 'completed',
        completedAt: index * 2 + 1,
      },
    },
  )
}

function assertTimingCount(count: number): void {
  if (count !== TURN_COUNT) throw new Error('invalid replay turn timing count')
}

function replayLifecycleWithStateCopies(): ThreadState {
  let state = emptyThread
  const turnTiming: Record<string, { startedAt?: number; completedAt?: number }> = {}
  for (const entry of entries) {
    if (entry.event.type === 'turn.started') {
      const previous = turnTiming[entry.event.turn.id]
      const startedAt = previous?.startedAt ?? entry.event.turn.createdAt
      turnTiming[entry.event.turn.id] = { ...previous, startedAt }
      state = {
        ...state,
        running: true,
        liveStart: state.items.length,
        activeTurn: { id: entry.event.turn.id, startedAt },
        turnTiming,
        plan: [],
        diff: undefined,
        diffTurnId: undefined,
      }
      continue
    }
    if (entry.event.type !== 'turn.completed') continue
    if (entry.event.completedAt !== undefined) {
      const previous = turnTiming[entry.event.turnId]
      turnTiming[entry.event.turnId] = {
        ...previous,
        completedAt: previous?.completedAt ?? entry.event.completedAt,
      }
    }
    state = {
      ...state,
      running: false,
      liveStart: state.items.length,
      activeTurn: undefined,
      approvals: [],
      turnTiming,
    }
  }
  return state
}

describe('long-thread lifecycle replay', () => {
  bench(
    'replays 5,000 turns through the single-event reducer',
    () => {
      const state = entries.reduce((current, entry) => reduce(current, entry.event), emptyThread)
      assertTimingCount(Object.keys(state.turnTiming).length)
    },
    OPTIONS,
  )

  bench(
    'replays 5,000 turns while copying state at each boundary',
    () => {
      assertTimingCount(Object.keys(replayLifecycleWithStateCopies().turnTiming).length)
    },
    REPLAY_OPTIONS,
  )

  bench(
    'replays 5,000 turns through one private replay state',
    () => {
      const state = reduceEventLog(emptyThread, entries)
      assertTimingCount(Object.keys(state.turnTiming).length)
    },
    REPLAY_OPTIONS,
  )
})
