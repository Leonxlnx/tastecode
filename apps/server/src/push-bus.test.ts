import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MAX_PUSH_BUFFER_BYTES, PushBus, type PushSocket } from './push-bus.js'

/**
 * The push path had no tests at all, and its failure mode is the worst kind:
 * a client that stops receiving without either side noticing.
 */

type FakeSocket = PushSocket & {
  sent: string[]
  terminated: number
  failNextSend: boolean
}

function socket(): FakeSocket {
  const fake: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    terminated: 0,
    failNextSend: false,
    send(payload: string, callback?: (error?: Error) => void) {
      if (fake.failNextSend) {
        fake.failNextSend = false
        callback?.(new Error('write failed'))
        return
      }
      fake.sent.push(payload)
      callback?.()
    },
    terminate() {
      fake.terminated += 1
    },
  }
  return fake
}

const SequencedFrameSchema = z.object({ sequence: z.number() })
const sequences = (client: FakeSocket): number[] =>
  client.sent.map((frame) => SequencedFrameSchema.parse(JSON.parse(frame)).sequence)

describe('PushBus', () => {
  it('allows a large history reply on a healthy socket without moving the push sequence', () => {
    const bus = new PushBus<FakeSocket>()
    const client = socket()
    bus.add(client)
    const reply = JSON.stringify({
      id: 1,
      result: { history: 'x'.repeat(MAX_PUSH_BUFFER_BYTES + 1) },
    })
    bus.reply(client, reply)
    expect(client.terminated).toBe(0)
    expect(client.sent).toEqual([reply])
    client.sent.length = 0
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: '/repo' })
    expect(sequences(client)).toEqual([1])
  })
  it('drops a stalled client on every send path while healthy clients keep receiving', () => {
    for (const kind of ['targeted', 'broadcast', 'recorded', 'reply'] as const) {
      const bus = new PushBus<FakeSocket>()
      const slow = socket()
      Object.defineProperty(slow, 'bufferedAmount', { value: MAX_PUSH_BUFFER_BYTES })
      const healthy = socket()
      bus.add(slow)
      if (kind === 'targeted')
        bus.send(slow, 'skills.changed', { provider: 'codex', projectPath: '/repo' })
      else if (kind === 'broadcast')
        bus.broadcast('skills.changed', { provider: 'codex', projectPath: '/repo' })
      else if (kind === 'reply') bus.reply(slow, '{"id":1,"result":{}}')
      else bus.broadcastRecordedEvent('thread.event', 'task', '{}', 1)
      expect(slow.terminated).toBe(1)
      expect(slow.sent).toHaveLength(0)
      bus.add(healthy)
      bus.broadcast('skills.changed', { provider: 'codex', projectPath: '/repo' })
      expect(healthy.sent).toHaveLength(1)
      expect(slow.terminated).toBe(1)
    }
  })
  it('numbers every connection from one, independently', () => {
    const bus = new PushBus()
    const first = socket()
    const second = socket()
    bus.add(first)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    bus.add(second)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    bus.remove(second)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })

    // A gap in these is how a client knows it missed something.
    expect(sequences(first)).toEqual([1, 2, 3])
    expect(sequences(second)).toEqual([1])
  })

  it('does not restart a live connection sequence when it is added twice', () => {
    const bus = new PushBus()
    const client = socket()
    bus.add(client)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    bus.add(client)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })

    expect(sequences(client)).toEqual([1, 2])
  })

  it('keeps clients that advance together on the same frame sequence', () => {
    const bus = new PushBus()
    const first = socket()
    const second = socket()
    bus.add(first)
    bus.add(second)

    bus.broadcastRecordedEvent(
      'thread.event',
      'thread-1',
      JSON.stringify({ type: 'turn.completed', turnId: 'turn-1' }),
      7,
    )

    expect(first.sent).toEqual(second.sent)
    expect(sequences(first)).toEqual([1])
    expect(sequences(second)).toEqual([1])
  })

  it('keeps a late joiner on its own recorded-event sequence', () => {
    const bus = new PushBus()
    const first = socket()
    const second = socket()
    bus.add(first)

    bus.broadcastRecordedEvent(
      'thread.event',
      'thread-1',
      JSON.stringify({ type: 'turn.completed', turnId: 'turn-1' }),
      7,
    )

    bus.add(second)
    bus.broadcastRecordedEvent(
      'thread.event',
      'thread-1',
      JSON.stringify({ type: 'turn.completed', turnId: 'turn-2' }),
      8,
    )

    expect(sequences(first)).toEqual([1, 2])
    expect(sequences(second)).toEqual([1])
    expect(JSON.parse(first.sent[1] ?? '')).toEqual({
      channel: 'thread.event',
      sequence: 2,
      data: {
        threadId: 'thread-1',
        event: { type: 'turn.completed', turnId: 'turn-2' },
        seq: 8,
      },
    })
    expect(JSON.parse(second.sent[0] ?? '')).toEqual({
      channel: 'thread.event',
      sequence: 1,
      data: {
        threadId: 'thread-1',
        event: { type: 'turn.completed', turnId: 'turn-2' },
        seq: 8,
      },
    })
  })

  it('broadcasts provider-neutral usage changes without provider-specific payloads', () => {
    const bus = new PushBus()
    const client = socket()
    bus.add(client)

    bus.broadcast('usage.changed', { provider: 'codex' })

    expect(JSON.parse(client.sent[0] ?? '')).toEqual({
      channel: 'usage.changed',
      sequence: 1,
      data: { provider: 'codex' },
    })
  })

  it('reuses stored event JSON without changing the push frame', () => {
    const bus = new PushBus()
    const client = socket()
    const event = {
      type: 'item.delta' as const,
      turnId: 'turn-1',
      itemId: 'item-1',
      textDelta: 'quote " and newline\n',
    }
    bus.add(client)

    bus.broadcastRecordedEvent('thread.event', 'thread-1', JSON.stringify(event), 42)

    expect(JSON.parse(client.sent[0] ?? '')).toEqual({
      channel: 'thread.event',
      sequence: 1,
      data: { threadId: 'thread-1', event, seq: 42 },
    })
  })

  it('refreshes the recorded thread framing when streams alternate', () => {
    const bus = new PushBus()
    const client = socket()
    const event = JSON.stringify({ type: 'turn.completed', turnId: 'turn-1' })
    bus.add(client)

    bus.broadcastRecordedEvent('thread.event', 'thread-1', event, 1)
    bus.broadcastRecordedEvent('sideChat.event', 'side"thread', event, 2)
    bus.broadcastRecordedEvent('thread.event', 'thread-1', event, 3)

    expect(client.sent.map((frame) => JSON.parse(frame).data.threadId)).toEqual([
      'thread-1',
      'side"thread',
      'thread-1',
    ])
  })

  it('closes a connection whose write failed instead of silently muting it', () => {
    // Dropping it from the map while leaving the socket open was the bug: the
    // client's onclose never fired, its gap detector only fires on a frame it
    // does receive, and the thread simply stopped updating forever.
    const bus = new PushBus()
    const client = socket()
    bus.add(client)
    client.failNextSend = true
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })

    expect(client.terminated).toBe(1)
  })

  it('never resurrects a removed connection with a restarted counter', () => {
    const bus = new PushBus()
    const client = socket()
    bus.add(client)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    bus.remove(client)

    // A targeted send after removal used to re-register at sequence 1, so the
    // numbers went backwards mid-connection.
    bus.send(client, 'skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    expect(sequences(client)).toEqual([1])
  })

  it('skips a socket that is not open rather than throwing at the caller', () => {
    const bus = new PushBus()
    const client = socket()
    bus.add(client)
    client.readyState = 3
    expect(() =>
      bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' }),
    ).not.toThrow()
    expect(client.sent).toHaveLength(0)
  })

  it('keeps broadcasting to healthy clients when one fails', () => {
    // One client resetting its connection must not starve the others of the
    // rest of a broadcast.
    const bus = new PushBus()
    const broken = socket()
    const healthy = socket()
    bus.add(broken)
    bus.add(healthy)
    broken.send = vi.fn(() => {
      throw new Error('socket is gone')
    })

    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    expect(sequences(healthy)).toEqual([1])
    expect(broken.terminated).toBe(1)
  })
})
