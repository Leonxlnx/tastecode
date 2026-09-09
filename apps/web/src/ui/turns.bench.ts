import { bench, describe } from 'vitest'
import { activityGroupAt, neighbourTurn, type TurnActivityGroup, type TurnMark } from './turns.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const groups: TurnActivityGroup[] = Array.from({ length: 10_000 }, (_, index) => ({
  items: [],
  firstIndex: index * 3,
  lastIndex: index * 3 + 1,
  elapsedMs: 0,
}))
const target = groups.at(-1)!.lastIndex

describe('long-turn activity lookup', () => {
  bench(
    'linear range lookup',
    () => {
      if (!groups.find((group) => target >= group.firstIndex && target <= group.lastIndex)) {
        throw new Error('group missing')
      }
    },
    OPTIONS,
  )

  bench(
    'binary range lookup',
    () => {
      if (!activityGroupAt(groups, target)) throw new Error('group missing')
    },
    OPTIONS,
  )
})

const turns: TurnMark[] = Array.from({ length: 10_000 }, (_, index) => ({
  turnId: `turn-${index}`,
  index: index * 3,
  count: 3,
}))
const currentTurnIndex = turns.at(-1)!.index + 1

describe('long-thread turn navigation', () => {
  bench(
    'filters every turn before moving to the previous one',
    () => {
      const before = turns.filter((turn) => turn.index < currentTurnIndex)
      if (before[before.length - 1]?.index !== turns.at(-1)?.index) {
        throw new Error('previous turn missing')
      }
    },
    OPTIONS,
  )

  bench(
    'uses indexed turn navigation',
    () => {
      if (neighbourTurn(turns, currentTurnIndex, 'prev') !== turns.at(-1)?.index) {
        throw new Error('previous turn missing')
      }
    },
    OPTIONS,
  )
})
