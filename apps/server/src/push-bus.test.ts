import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PushBus, type PushSocket } from './push-bus.js'

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
  it('numbers every connection from one, independently', () => {
    const bus = new PushBus()
    const first = socket()
    const second = socket()
    bus.add(first)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })
    bus.add(second)
    bus.broadcast('skills.changed', { provider: 'codex', projectPath: 'C:\\repo' })

    // A gap in these is how a client knows it missed something.
    expect(sequences(first)).toEqual([1, 2])
    expect(sequences(second)).toEqual([1])
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
