import { bench, describe } from 'vitest'
import { PushBus, type PushSocket } from './push-bus.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const CLIENT_COUNT = 8
const BROADCAST_COUNT = 100
let bytesSent = 0

type BenchmarkSocket = PushSocket & { sentBytes: number }

function socket(): BenchmarkSocket {
  const client = {
    OPEN: 1,
    readyState: 1,
    sentBytes: 0,
    terminate() {},
  } as BenchmarkSocket
  client.send = ((payload: string, callback?: (error?: Error) => void) => {
    const byteLength = Buffer.byteLength(payload)
    bytesSent += byteLength
    client.sentBytes += byteLength
    callback?.()
  }) as BenchmarkSocket['send']
  return client
}

const clients = Array.from({ length: CLIENT_COUNT }, socket)
const data = {
  threadId: 'thread-1',
  seq: 1,
  event: {
    type: 'item.delta' as const,
    turnId: 'turn-1',
    itemId: 'answer-1',
    textDelta: 'x'.repeat(16_384),
  },
}
const serializedEvent = JSON.stringify(data.event)
const bus = new PushBus<BenchmarkSocket>()
for (const client of clients) bus.add(client)

const legacySequences = new Map(clients.map((client) => [client, 0]))
function legacyBroadcast(): void {
  for (const client of clients) {
    const sequence = (legacySequences.get(client) ?? 0) + 1
    legacySequences.set(client, sequence)
    client.send(JSON.stringify({ channel: 'thread.event', sequence, data }))
  }
}

describe('multi-client streamed push serialization', () => {
  bench(
    'serializes one 16 KiB delta for every client',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) legacyBroadcast()
    },
    OPTIONS,
  )

  bench(
    'serializes one 16 KiB delta once per broadcast',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        bus.broadcast('thread.event', data)
      }
    },
    OPTIONS,
  )

  bench(
    'reuses the stored 16 KiB event JSON for every broadcast',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        bus.broadcastRecordedEvent('thread.event', data.threadId, serializedEvent, data.seq)
      }
    },
    OPTIONS,
  )
})
