// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { IndeterminateRequestError, Transport } from './transport.js'

const RequestFrameSchema = z.object({ id: z.string() })

/**
 * The client half of the wire protocol had zero coverage — and its edges are
 * exactly where sessions used to hang at "starting" forever. These pin the
 * reconnect and failure behavior fixed in the overnight batch.
 */

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  static CONNECTING = 0
  readonly OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const userFrames = (socket: FakeSocket): string[] =>
  socket.sent.filter((frame) => !frame.includes('client.capabilities'))

const completedThreadEvent = (turnId: string) => ({
  threadId: 'thread-1',
  event: {
    type: 'turn.completed' as const,
    turnId,
    status: 'completed' as const,
    error: null,
  },
})

describe('Transport', () => {
  it('rejects in-flight requests when the socket drops instead of hanging', async () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()

    const pending = transport.request('system.info', {})
    expect(userFrames(socket)).toHaveLength(1)

    socket.close()
    await expect(pending).rejects.toBeInstanceOf(IndeterminateRequestError)
  })

  it('flushes requests queued while disconnected exactly once after reconnect', async () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const first = FakeSocket.instances[0]!

    // Still CONNECTING: the frame must queue, not vanish. The later drop
    // rejects it (transmitted frames die with their socket) — expected here.
    transport.request('system.info', {}).catch(() => undefined)
    expect(userFrames(first)).toHaveLength(0)

    first.open()
    expect(userFrames(first)).toHaveLength(1)

    // A drop and reconnect must not resend the already-transmitted frame.
    first.close()
    vi.advanceTimersByTime(0)
    const second = FakeSocket.instances[1]!
    second.open()
    expect(userFrames(second)).toHaveLength(0)
  })

  it('answers a request queued during reconnect without replaying it on another socket', async () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.close()

    const queued = transport.request('system.info', {})
    expect(userFrames(first)).toHaveLength(0)
    vi.advanceTimersByTime(0)
    const second = FakeSocket.instances[1]!
    second.open()
    expect(userFrames(second)).toHaveLength(1)

    const frame = RequestFrameSchema.parse(JSON.parse(userFrames(second)[0]!))
    second.onmessage?.({
      data: JSON.stringify({
        id: frame.id,
        result: { serverVersion: 'test', protocolVersion: 1, platform: 'darwin' },
      }),
    })
    await expect(queued).resolves.toMatchObject({ serverVersion: 'test' })

    second.close()
    vi.advanceTimersByTime(0)
    const third = FakeSocket.instances[2]!
    third.open()
    expect(userFrames(third)).toHaveLength(0)
  })

  it('flushes queued mutations before open-state resync requests', () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.close()

    transport
      .request('thread.rename', { threadId: 'thread-1', title: 'Queued rename' })
      .catch(() => undefined)
    transport.onState((state) => {
      if (state === 'open') transport.request('projects.list', {}).catch(() => undefined)
    })
    vi.advanceTimersByTime(0)
    const second = FakeSocket.instances[1]!
    second.open()

    expect(userFrames(second).map((frame) => JSON.parse(frame).method)).toEqual([
      'thread.rename',
      'projects.list',
    ])
  })

  it('replaces a half-dead open socket when a wake-up health check times out', async () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const first = FakeSocket.instances[0]!
    first.open()

    const checking = transport.ensureHealthy(500)
    expect(JSON.parse(userFrames(first)[0]!)).toMatchObject({ method: 'system.info' })

    await vi.advanceTimersByTimeAsync(500)
    await checking
    expect(transport.state).toBe('reconnecting')
    await vi.runOnlyPendingTimersAsync()
    const second = FakeSocket.instances[1]!
    expect(second).toBeTruthy()
    expect(transport.state).toBe('reconnecting')
  })

  it('keeps a healthy socket when the wake-up probe answers', async () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()

    const checking = transport.ensureHealthy(500)
    const frame = RequestFrameSchema.parse(JSON.parse(userFrames(socket)[0]!))
    socket.onmessage?.({
      data: JSON.stringify({
        id: frame.id,
        result: { serverVersion: 'test', protocolVersion: 1, platform: 'darwin' },
      }),
    })
    await checking
    vi.runAllTimers()

    expect(FakeSocket.instances).toHaveLength(1)
    expect(transport.state).toBe('open')
  })

  it('backs off when a server accepts and immediately rejects the socket', () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.close()
    vi.advanceTimersByTime(0)

    const second = FakeSocket.instances[1]!
    second.open()
    second.close()
    vi.advanceTimersByTime(99)
    expect(FakeSocket.instances).toHaveLength(2)

    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('does not resurrect a reconnect after the transport is closed', () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.close()

    transport.close()
    vi.runAllTimers()

    expect(FakeSocket.instances).toHaveLength(1)
    expect(transport.state).toBe('closed')
  })

  it('never surfaces the literal string "undefined" for a message-less error frame', async () => {
    const transport = new Transport('ws://test')
    transport.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()

    const pending = transport.request('system.info', {})
    const frame = RequestFrameSchema.parse(JSON.parse(userFrames(socket)[0]!))
    socket.onmessage?.({ data: JSON.stringify({ id: frame.id, error: {} }) })

    await expect(pending).rejects.toThrow('The server reported an error.')
  })

  it('applies a push sequence only once', () => {
    const transport = new Transport('ws://test')
    const listener = vi.fn()
    transport.on('thread.event', listener)
    transport.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()

    const frame = JSON.stringify({
      channel: 'thread.event',
      sequence: 1,
      data: { ...completedThreadEvent('turn-1'), seq: 1 },
    })
    socket.onmessage?.({ data: frame })
    socket.onmessage?.({ data: frame })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reports a forward sequence gap so the owner can resync', () => {
    const transport = new Transport('ws://test')
    const gap = vi.fn()
    transport.onSequenceGap(gap)
    transport.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()

    socket.onmessage?.({
      data: JSON.stringify({ channel: 'server.welcome', sequence: 1, data: {} }),
    })
    socket.onmessage?.({
      data: JSON.stringify({ channel: 'thread.event', sequence: 3, data: {} }),
    })

    expect(gap).toHaveBeenCalledOnce()
    expect(gap).toHaveBeenCalledWith(2, 3)
  })

  it('ignores pushes from a socket replaced by a failed health check', async () => {
    const transport = new Transport('ws://test')
    const listener = vi.fn()
    transport.on('thread.event', listener)
    transport.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.onmessage?.({
      data: JSON.stringify({
        channel: 'thread.event',
        sequence: 1,
        data: completedThreadEvent('first'),
      }),
    })

    const checking = transport.ensureHealthy(1)
    await vi.advanceTimersByTimeAsync(1)
    await checking
    await vi.runOnlyPendingTimersAsync()
    const second = FakeSocket.instances[1]!
    second.open()

    first.onmessage?.({
      data: JSON.stringify({
        channel: 'thread.event',
        sequence: 2,
        data: completedThreadEvent('stale'),
      }),
    })
    second.onmessage?.({
      data: JSON.stringify({
        channel: 'thread.event',
        sequence: 1,
        data: completedThreadEvent('second'),
      }),
    })

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalledWith(completedThreadEvent('stale'))
  })

  it('starts push sequence tracking fresh on each connection', () => {
    const transport = new Transport('ws://test')
    const gap = vi.fn()
    transport.onSequenceGap(gap)
    transport.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.onmessage?.({
      data: JSON.stringify({ channel: 'server.welcome', sequence: 1, data: {} }),
    })
    first.onmessage?.({
      data: JSON.stringify({ channel: 'thread.event', sequence: 2, data: {} }),
    })
    first.close()
    vi.advanceTimersByTime(0)

    const second = FakeSocket.instances[1]!
    second.open()
    second.onmessage?.({
      data: JSON.stringify({ channel: 'server.welcome', sequence: 1, data: {} }),
    })

    expect(gap).not.toHaveBeenCalled()
  })
})
