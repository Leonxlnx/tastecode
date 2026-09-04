// @vitest-environment happy-dom
import { bench, describe } from 'vitest'
import type { Item } from '@harness/contracts'
import {
  createRepeatedDesignRowLookup,
  createRepeatedDesignRowProjector,
  isRepeatedDesignRow,
} from './Thread.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const first: Item = {
  id: 'first',
  turnId: 'turn',
  type: 'tool_call',
  status: 'completed',
  text: 'design:build',
  createdAt: 0,
}
const activities: Item[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `command-${index}`,
  turnId: 'turn',
  type: 'command',
  status: 'completed',
  command: 'test',
  createdAt: index + 1,
}))
const repeated: Item = { ...first, id: 'repeated', createdAt: activities.length + 1 }
const items = [first, ...activities, repeated]
const repeatedIndex = items.length - 1
const lookup = createRepeatedDesignRowLookup(items)
const structuralFrames = [
  items,
  [
    ...items,
    {
      id: 'answer',
      turnId: 'turn',
      type: 'message' as const,
      role: 'assistant' as const,
      status: 'started' as const,
      text: 'x',
      createdAt: items.length + 1,
    },
  ],
]
const projectLookup = createRepeatedDesignRowProjector()
projectLookup(items)(repeated, repeatedIndex)
let structuralFrame = 0

describe('long design-thread row suppression', () => {
  bench(
    'rescans prior activity on every frame',
    () => {
      if (!isRepeatedDesignRow(repeated, items, repeatedIndex)) {
        throw new Error('repeated phase missing')
      }
    },
    OPTIONS,
  )

  bench(
    'reuses the structural lookup result',
    () => {
      if (!lookup(repeated, repeatedIndex)) throw new Error('repeated phase missing')
    },
    OPTIONS,
  )

  bench(
    'rescans a repeated phase after each structural tail change',
    () => {
      structuralFrame = structuralFrame === 0 ? 1 : 0
      const frame = structuralFrames[structuralFrame]!
      if (!createRepeatedDesignRowLookup(frame)(repeated, repeatedIndex)) {
        throw new Error('repeated phase missing')
      }
    },
    OPTIONS,
  )

  bench(
    'retains a repeated phase across structural tail changes',
    () => {
      structuralFrame = structuralFrame === 0 ? 1 : 0
      if (!projectLookup(structuralFrames[structuralFrame]!)(repeated, repeatedIndex)) {
        throw new Error('repeated phase missing')
      }
    },
    OPTIONS,
  )
})
