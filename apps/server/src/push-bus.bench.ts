import { bench, describe } from 'vitest'
import { PushBus, type PushSocket } from './push-bus.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const PAIRED_OPTIONS = { iterations: 100, time: 0, warmupIterations: 20, warmupTime: 0 }
const CLIENT_COUNT = 8
const BROADCAST_COUNT = 100
const SHORT_BROADCAST_COUNT = 1_000
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
const smallData = { provider: 'codex' as const }
const singleClientBus = new PushBus<BenchmarkSocket>()
singleClientBus.add(socket())
const bus = new PushBus<BenchmarkSocket>()
for (const client of clients) bus.add(client)
const smallSingleClientBus = new PushBus<BenchmarkSocket>()
smallSingleClientBus.add(socket())
const smallMultiClientBus = new PushBus<BenchmarkSocket>()
for (let index = 0; index < CLIENT_COUNT; index += 1) smallMultiClientBus.add(socket())

type PreviousSocketState = { sequence: number; onSend: (error?: Error) => void }

function previousSockets(count: number): Map<BenchmarkSocket, PreviousSocketState> {
  const sockets = new Map<BenchmarkSocket, PreviousSocketState>()
  for (let index = 0; index < count; index += 1) {
    const client = socket()
    sockets.set(client, {
      sequence: 0,
      onSend: (error) => {
        if (error) client.terminate()
      },
    })
  }
  return sockets
}

function previousRecordedBroadcast(sockets: Map<BenchmarkSocket, PreviousSocketState>): void {
  let prefix: string | undefined
  let dataJson: string | undefined
  for (const client of sockets.keys()) {
    if (client.readyState !== client.OPEN) continue
    prefix ??= '{"channel":"thread.event","sequence":'
    dataJson ??= `{"threadId":"${data.threadId}","event":${serializedEvent},"seq":${data.seq}}`
    const state = sockets.get(client)
    if (state === undefined) continue
    const sequence = ++state.sequence
    try {
      client.send(`${prefix}${sequence},"data":${dataJson}}`, state.onSend)
    } catch {
      client.terminate()
    }
  }
}

function previousSmallBroadcast(sockets: Map<BenchmarkSocket, PreviousSocketState>): void {
  let prefix: string | undefined
  let dataJson: string | undefined
  for (const client of sockets.keys()) {
    if (client.readyState !== client.OPEN) continue
    prefix ??= '{"channel":"usage.changed","sequence":'
    dataJson ??= JSON.stringify(smallData)
    const state = sockets.get(client)
    if (state === undefined) continue
    const sequence = ++state.sequence
    try {
      client.send(`${prefix}${sequence},"data":${dataJson}}`, state.onSend)
    } catch {
      client.terminate()
    }
  }
}

const previousSingleSockets = previousSockets(1)
const previousMultiSockets = previousSockets(CLIENT_COUNT)
const previousSmallSingleSockets = previousSockets(1)
const previousSmallMultiSockets = previousSockets(CLIENT_COUNT)

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
    'reuses the stored 16 KiB event JSON for one client',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        singleClientBus.broadcastRecordedEvent(
          'thread.event',
          data.threadId,
          serializedEvent,
          data.seq,
        )
      }
    },
    OPTIONS,
  )

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

describe('paired previous/current recorded push', () => {
  bench(
    'previous path for one client',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        previousRecordedBroadcast(previousSingleSockets)
      }
    },
    PAIRED_OPTIONS,
  )

  bench(
    'current path for one client',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        singleClientBus.broadcastRecordedEvent(
          'thread.event',
          data.threadId,
          serializedEvent,
          data.seq,
        )
      }
    },
    PAIRED_OPTIONS,
  )

  bench(
    'previous path for eight clients',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        previousRecordedBroadcast(previousMultiSockets)
      }
    },
    PAIRED_OPTIONS,
  )

  bench(
    'current path for eight clients',
    () => {
      for (let index = 0; index < BROADCAST_COUNT; index += 1) {
        bus.broadcastRecordedEvent('thread.event', data.threadId, serializedEvent, data.seq)
      }
    },
    PAIRED_OPTIONS,
  )
})

describe('paired previous/current short push', () => {
  bench(
    'previous path for one client',
    () => {
      for (let index = 0; index < SHORT_BROADCAST_COUNT; index += 1) {
        previousSmallBroadcast(previousSmallSingleSockets)
      }
    },
    PAIRED_OPTIONS,
  )

  bench(
    'current path for one client',
    () => {
      for (let index = 0; index < SHORT_BROADCAST_COUNT; index += 1) {
        smallSingleClientBus.broadcast('usage.changed', smallData)
      }
    },
    PAIRED_OPTIONS,
  )

  bench(
    'previous path for eight clients',
    () => {
      for (let index = 0; index < SHORT_BROADCAST_COUNT; index += 1) {
        previousSmallBroadcast(previousSmallMultiSockets)
      }
    },
    PAIRED_OPTIONS,
  )

  bench(
    'current path for eight clients',
    () => {
      for (let index = 0; index < SHORT_BROADCAST_COUNT; index += 1) {
        smallMultiClientBus.broadcast('usage.changed', smallData)
      }
    },
    PAIRED_OPTIONS,
  )
})
