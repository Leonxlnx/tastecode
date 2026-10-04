import { bench, describe } from 'vitest'
import { SerializedResult, serializeSuccessResponse } from './response-serializer.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const events = Array.from({ length: 1_000 }, (_, index) => ({
  seq: index + 1,
  event: {
    type: 'item.completed',
    item: {
      id: `message-${index}`,
      turnId: `turn-${index}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: 'x'.repeat(3_072),
      createdAt: index,
    },
  },
}))
const result = { events, running: false }
const savedEventsJson = JSON.stringify(events)
const savedResult = new SerializedResult(`{"events":${savedEventsJson},"running":false}`)
let encodedBytes = 0

function wireBytes(value: string): number {
  // Force the same full-string scan that WebSocket UTF-8 encoding performs.
  return Buffer.byteLength(value)
}

describe('three-megabyte history response encoding', () => {
  bench(
    'encodes the immutable replay again for WebSocket',
    () => {
      encodedBytes += wireBytes(serializeSuccessResponse('history', result))
    },
    OPTIONS,
  )

  bench(
    'reuses the JSON already written to the replay snapshot',
    () => {
      encodedBytes += wireBytes(serializeSuccessResponse('history', savedResult))
    },
    OPTIONS,
  )
})
