import { bench, describe } from 'vitest'
import { activeTurnAnchor } from './scroll-mode.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const items = [
  ...Array.from({ length: 10_000 }, (_, index) => ({
    id: `history-${index}`,
    turnId: `turn-${index}`,
    type: 'message',
    role: 'assistant',
  })),
  { id: 'active', turnId: 'active-turn', type: 'message', role: 'user' },
]

describe('long-thread active turn anchor', () => {
  bench(
    'searches completed history before the active turn',
    () => {
      const index = items.findIndex((item) => item.turnId === 'active-turn')
      if (index !== 10_000) throw new Error(`invalid linear index: ${index}`)
    },
    OPTIONS,
  )

  bench(
    'searches only the active tail',
    () => {
      const anchor = activeTurnAnchor(items, 'active-turn', 10_000)
      if (anchor?.index !== 10_000) throw new Error(`invalid tail index: ${anchor?.index}`)
    },
    OPTIONS,
  )
})
