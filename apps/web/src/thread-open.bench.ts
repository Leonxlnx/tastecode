import { bench, describe } from 'vitest'
import { methods, type DomainEvent, type ResultOf } from '@harness/contracts'
import { emptyThread, prependOlderHistory, reduceEventLog } from './thread-store.js'
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

// The same three megabytes as one hundred ten-entry turns. A paged open
// parses, validates and replays only the newest ten; scrolling up adds twenty.
const TURN_ENTRIES = 10
const NEWEST_TURNS = 10
const OLDER_TURNS = 20
const turnEntries = events.map(({ seq, event }) =>
  event.type === 'item.completed'
    ? {
        seq,
        event: {
          ...event,
          item: { ...event.item, turnId: `turn-${Math.floor((seq - 1) / TURN_ENTRIES)}` },
        },
      }
    : { seq, event },
)
const newestStart = ENTRY_COUNT - NEWEST_TURNS * TURN_ENTRIES
const olderStart = newestStart - OLDER_TURNS * TURN_ENTRIES
const page = { olderCursor: 'cursor', snapshotSeq: ENTRY_COUNT }
const fullText = JSON.stringify({ events: turnEntries, running: false })
const newestText = JSON.stringify({
  events: turnEntries.slice(newestStart),
  running: false,
  page,
})
const olderText = JSON.stringify({
  events: turnEntries.slice(olderStart, newestStart),
  running: false,
  page,
})
const openText = (text: string) =>
  reduceEventLog(emptyThread, parseMethodResult('thread.history', JSON.parse(text)).events)
const newestState = openText(newestText)

describe('paged long-thread open', () => {
  bench(
    'opens all one hundred turns',
    () => {
      if (openText(fullText).items.length !== ENTRY_COUNT) throw new Error('missing turns')
    },
    OPTIONS,
  )

  bench(
    'opens the newest ten turns',
    () => {
      if (openText(newestText).items.length !== NEWEST_TURNS * TURN_ENTRIES) {
        throw new Error('missing newest turns')
      }
    },
    OPTIONS,
  )

  bench(
    'prepends twenty older turns',
    () => {
      const older = parseMethodResult('thread.history', JSON.parse(olderText))
      const state = prependOlderHistory(newestState, older.events, 'cursor')
      if (state.items.length !== (NEWEST_TURNS + OLDER_TURNS) * TURN_ENTRIES) {
        throw new Error('missing older turns')
      }
    },
    OPTIONS,
  )
})
