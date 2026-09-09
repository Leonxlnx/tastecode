// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  IndeterminateRequestError,
  parseIncomingFrame,
  parseResponseFrame,
  Transport,
  TRANSPORT_LIMITS,
} from './transport.js'
import {
  parseChannelData,
  parseMethodResult,
  parseProjectsListResult,
} from './transport-validation.js'
import { parseProvidersListResult } from './transport-startup-validation.js'

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
  bufferedAmount = 0
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
  it('bounds disconnected requests and expires them without sending on reconnect', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.connect()
    const pending = Array.from({ length: TRANSPORT_LIMITS.requests }, () =>
      transport.request('projects.list', {}).catch((error: unknown) => error),
    )
    await expect(transport.request('projects.list', {})).rejects.toThrow('Too many requests')
    await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs)
    for (const error of await Promise.all(pending))
      expect(error).toMatchObject({ message: expect.stringContaining('before it could be sent') })
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    expect(userFrames(socket)).toHaveLength(0)
    transport.close()
  })

  it('marks a sent mutation as uncertain after its deadline and never repeats it', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.connect()
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    const result = transport
      .request('thread.rename', { threadId: 'thread', title: 'Saved?' })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs)
    expect(await result).toBeInstanceOf(IndeterminateRequestError)
    socket.close()
    await vi.advanceTimersByTimeAsync(1)
    const replacement = FakeSocket.instances.at(-1)!
    expect(replacement).not.toBe(socket)
    replacement.open()
    expect(userFrames(replacement)).toHaveLength(0)
    transport.close()
  })

  it('refuses a stalled socket before adding more buffered data', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.connect()
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    socket.bufferedAmount = TRANSPORT_LIMITS.bufferedBytes
    await expect(
      transport.request('thread.rename', { threadId: 'thread', title: 'name' }),
    ).rejects.toThrow('connection is busy')
    expect(userFrames(socket)).toHaveLength(0)
    socket.bufferedAmount = 0
    const pending = transport.request('projects.list', {}).catch(() => undefined)
    expect(userFrames(socket)).toHaveLength(1)
    transport.close()
    await pending
  })

  it('bounds the retained bytes for requests waiting offline', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    const data = 'x'.repeat(34_952_536)
    const first = transport
      .request('attachments.saveImage', { mimeType: 'image/png', data })
      .catch(() => undefined)
    await expect(
      transport.request('attachments.saveImage', { mimeType: 'image/png', data }),
    ).rejects.toThrow('Too much data')
    transport.close()
    await first
  })

  it('drops a socket when push validation cannot keep up with its queue', () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.on('terminal.output', () => {})
    transport.connect()
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    for (let sequence = 1; sequence <= TRANSPORT_LIMITS.validationFrames + 1; sequence += 1) {
      socket.onmessage?.({
        data: JSON.stringify({
          channel: 'terminal.output',
          sequence,
          data: { terminalId: 'terminal', data: 'text' },
        }),
      })
    }
    expect(transport.state).toBe('reconnecting')
    expect(socket.readyState).toBe(3)
    transport.close()
  })

  it('bounds bytes retained while the push validator loads', () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.on('terminal.output', () => {})
    transport.connect()
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    socket.onmessage?.({
      data: JSON.stringify({
        channel: 'terminal.output',
        sequence: 1,
        data: { terminalId: 'terminal', data: 'x'.repeat(TRANSPORT_LIMITS.validationBytes / 2) },
      }),
    })
    expect(transport.state).toBe('reconnecting')
    transport.close()
  })

  it('bounds reply data awaiting validation and releases it when closed', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.connect()
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    const calls = [0, 1].map(() =>
      transport.request('thread.history', { threadId: 'thread' }).catch((error: unknown) => error),
    )
    const data = 'x'.repeat(34_952_536)
    for (const frame of userFrames(socket)) {
      const { id } = RequestFrameSchema.parse(JSON.parse(frame))
      socket.onmessage?.({
        data: JSON.stringify({ id, result: { events: [], running: false, ignored: data } }),
      })
    }
    expect(transport.state).toBe('reconnecting')
    transport.close()
    for (const result of await Promise.all(calls)) {
      expect(result).toBeInstanceOf(IndeterminateRequestError)
    }
  })

  it('rejects malformed push envelopes before dispatch', () => {
    expect(parseIncomingFrame('{')).toBeUndefined()
    expect(
      parseIncomingFrame(JSON.stringify({ channel: 'thread.event', data: {} })),
    ).toBeUndefined()
    expect(
      parseIncomingFrame(JSON.stringify({ channel: 'thread.event', sequence: '1', data: {} })),
    ).toBeUndefined()
  })

  it('validates streamed thread deltas without keeping unknown wire fields', () => {
    expect(
      parseChannelData('thread.event', {
        threadId: 'thread-1',
        seq: 4,
        ignored: true,
        event: {
          type: 'item.delta',
          turnId: 'turn-1',
          itemId: 'item-1',
          textDelta: 'next',
          ignored: true,
        },
      }),
    ).toEqual({
      threadId: 'thread-1',
      seq: 4,
      event: {
        type: 'item.delta',
        turnId: 'turn-1',
        itemId: 'item-1',
        textDelta: 'next',
      },
    })
    expect(() =>
      parseChannelData('thread.event', {
        threadId: 'thread-1',
        event: { type: 'item.delta', turnId: 'turn-1', itemId: 'item-1' },
      }),
    ).toThrow()
  })

  it('reads successful response envelopes without keeping unknown wire fields', () => {
    expect(parseResponseFrame({ id: '1', result: { ok: true }, ignored: true })).toEqual({
      id: '1',
      result: { ok: true },
    })
    expect(parseResponseFrame({ id: 1, result: {} })).toBeUndefined()
    expect(parseResponseFrame({ id: '1' })).toBeUndefined()
  })

  it('reads canonical and legacy error envelopes without loading Zod', () => {
    expect(parseResponseFrame({ id: '1', error: {} })).toEqual({ id: '1', error: {} })
    expect(
      parseResponseFrame({
        id: '2',
        error: { code: 'internal', message: '', detail: '', ignored: true },
      }),
    ).toEqual({ id: '2', error: { message: '', detail: '' } })
    expect(parseResponseFrame({ id: '3', error: { message: '' } })).toBeUndefined()
    expect(parseResponseFrame({ id: '4', error: { detail: 1 } })).toBeUndefined()
  })

  it('validates terminal output without keeping unknown wire fields', () => {
    expect(
      parseChannelData('terminal.output', {
        terminalId: 'terminal-1',
        data: 'output',
        ignored: true,
      }),
    ).toEqual({ terminalId: 'terminal-1', data: 'output' })
    expect(() => parseChannelData('terminal.output', { terminalId: '', data: 'output' })).toThrow()
  })

  it('validates a project list in place and rejects invalid nested rows', () => {
    const result = {
      projects: [
        {
          path: '/project',
          name: 'Project',
          pinned: false,
          createdAt: 1,
          sessions: [
            {
              id: 'thread-1',
              title: 'Thread',
              provider: 'codex',
              createdAt: 2,
              running: false,
              pinned: true,
              status: 'ready',
              unread: true,
              lifecycle: { state: 'active', keepActive: false, wokeAt: 3 },
            },
          ],
        },
      ],
    }

    expect(parseProjectsListResult(result)).toBe(result)
    expect(parseMethodResult('projects.list', result)).toBe(result)
    expect(
      parseProjectsListResult({
        ...result,
        projects: [
          {
            ...result.projects[0],
            sessions: [{ ...result.projects[0]!.sessions[0], provider: 'unknown' }],
          },
        ],
      }),
    ).toBeUndefined()
    expect(() =>
      parseMethodResult('projects.list', {
        ...result,
        projects: [
          {
            ...result.projects[0],
            sessions: [
              {
                ...result.projects[0]!.sessions[0],
                lifecycle: { state: 'snoozed', snoozedAt: 3, wakeAt: -1 },
              },
            ],
          },
        ],
      }),
    ).toThrow()
  })

  it('validates the startup provider list without loading the full contract graph', () => {
    const result = {
      providers: [
        {
          id: 'codex' as const,
          displayName: 'Codex',
          installed: true,
          version: '1.2.3',
          auth: 'authenticated' as const,
          capabilities: {
            steer: true,
            fork: true,
            interrupt: true,
            reasoningItems: true,
            approvals: true,
            userInput: true,
            autoReview: true,
            images: true,
          },
          setup: {
            installUrl: 'https://example.com/install',
            installCommand: 'npm install codex',
            login: 'provider' as const,
          },
        },
      ],
    }

    expect(parseProvidersListResult(result)).toBe(result)
    expect(parseMethodResult('providers.list', result)).toBe(result)
    for (const loginOpensBrowser of [true, false, undefined]) {
      const candidate = {
        providers: [
          {
            ...result.providers[0],
            setup: { ...result.providers[0]!.setup, loginOpensBrowser },
          },
        ],
      }
      expect(parseProvidersListResult(candidate)).toBe(candidate)
    }
    for (const loginOpensBrowser of ['false', null]) {
      expect(
        parseProvidersListResult({
          providers: [
            {
              ...result.providers[0],
              setup: { ...result.providers[0]!.setup, loginOpensBrowser },
            },
          ],
        }),
      ).toBeUndefined()
    }
    expect(
      parseProvidersListResult({
        providers: [{ ...result.providers[0], capabilities: { steer: true } }],
      }),
    ).toBeUndefined()
    expect(
      parseProvidersListResult({
        providers: [
          { ...result.providers[0], setup: { installUrl: 'not a url', login: 'provider' } },
        ],
      }),
    ).toBeUndefined()
  })

  it('keeps cold-start retries connecting and caps their delay', () => {
    const transport = new Transport('ws://test')
    transport.connect()
    FakeSocket.instances[0]!.close()

    expect(transport.state).toBe('connecting')
    vi.advanceTimersByTime(0)
    FakeSocket.instances[1]!.close()
    vi.advanceTimersByTime(99)
    expect(FakeSocket.instances).toHaveLength(2)

    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
    expect(transport.state).toBe('connecting')
  })

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
    vi.advanceTimersByTime(500)

    expect(FakeSocket.instances).toHaveLength(1)
    expect(transport.state).toBe('open')
    transport.close()
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

  it('applies a push sequence only once', async () => {
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

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
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

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
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
