import { bench, describe } from 'vitest'
import { methods, type DomainEvent, type ResultOf } from '@harness/contracts'
import { emptyThread, reduceEventLog } from './thread-store.js'
import { parseMethodResult } from './transport-validation.js'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 }
const ENTRY_COUNT = 1_000
const MESSAGE_TEXT = 'x'.repeat(3_072)

const events: Array<{ seq: number; event: DomainEvent }> = Array.from(
  { length: ENTRY_COUNT },
  (_, index) => ({
    seq: index + 1,
    event: {
      type: 'item.completed',
      item: {
        id: `message-${index}`,
        turnId: `turn-${index}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: MESSAGE_TEXT,
        createdAt: index,
      },
    },
  }),
)
const result: ResultOf<'thread.history'> = { events, running: false }
const serialized = JSON.stringify(result)
let encodedCharacters = 0

describe('three-megabyte long-thread open stages', () => {
  bench(
    'encodes the immutable server result',
    () => {
      encodedCharacters += JSON.stringify(result).length
    },
    OPTIONS,
  )

  bench(
    'parses the WebSocket result JSON',
    () => {
      const parsed = JSON.parse(serialized) as ResultOf<'thread.history'>
      if (parsed.events.length !== ENTRY_COUNT) throw new Error('missing parsed history')
    },
    OPTIONS,
  )

  bench(
    'validates and copies the parsed history through the result schema',
    () => {
      if (methods['thread.history'].result.parse(result).events.length !== ENTRY_COUNT) {
        throw new Error('missing validated history')
      }
    },
    OPTIONS,
  )

  bench(
    'runs the production history result parser',
    () => {
      if (parseMethodResult('thread.history', result).events.length !== ENTRY_COUNT) {
        throw new Error('missing production history')
      }
    },
    OPTIONS,
  )

  bench(
    'replays the compact history into renderer state',
    () => {
      if (reduceEventLog(emptyThread, events).items.length !== ENTRY_COUNT) {
        throw new Error('missing replayed history')
      }
    },
    OPTIONS,
  )
})
