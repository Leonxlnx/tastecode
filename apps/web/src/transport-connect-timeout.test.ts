// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWN_SERVER_LISTEN_WAIT_MS, Transport, TRANSPORT_LIMITS } from './transport.js'

class Socket {
  static instances: Socket[] = []
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  readyState = Socket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor() {
    Socket.instances.push(this)
  }
  send(frame: string) {
    this.sent.push(frame)
  }
  open() {
    this.readyState = Socket.OPEN
    this.onopen?.()
  }
  close() {
    this.readyState = Socket.CLOSED
    this.onclose?.()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  Socket.instances = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('connection handshake deadline', () => {
  it('retries a stalled cold handshake and flushes queued requests exactly once', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.connect()
    const first = Socket.instances[0]!
    const pending = transport.request('projects.list', {})
    await vi.advanceTimersByTimeAsync(10_001)
    expect(first.readyState).toBe(Socket.CLOSED)
    const replacement = Socket.instances.at(-1)!
    expect(replacement).not.toBe(first)
    expect(transport.state).toBe('connecting')
    first.open()
    expect(first.sent).toHaveLength(0)
    replacement.open()
    const frames = replacement.sent.filter((frame) => frame.includes('projects.list'))
    expect(frames).toHaveLength(1)
    const request = JSON.parse(frames[0]!) as { id: string }
    replacement.onmessage?.({ data: JSON.stringify({ id: request.id, result: { projects: [] } }) })
    await expect(pending).resolves.toEqual({ projects: [] })
    transport.close()
  })

  it('bounds reconnect handshakes too and cancels the timer after opening or closing', async () => {
    const transport = new Transport('ws://127.0.0.1:4311')
    transport.connect()
    Socket.instances[0]!.open()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(Socket.instances).toHaveLength(1)
    expect(transport.state).toBe('open')
    Socket.instances[0]!.close()
    await vi.advanceTimersByTimeAsync(1)
    const stalled = Socket.instances.at(-1)!
    await vi.advanceTimersByTimeAsync(10_100)
    expect(stalled.readyState).toBe(Socket.CLOSED)
    expect(transport.state).toBe('reconnecting')
    const count = Socket.instances.length
    const closing = Socket.instances.at(-1)!
    transport.close()
    closing.open()
    await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs)
    expect(transport.state).toBe('closed')
    expect(Socket.instances).toHaveLength(count)
    expect(closing.sent).toHaveLength(0)
  })
})

describe('first connect to the server the desktop started', () => {
  function listening() {
    let settle!: () => void
    const promise = new Promise<void>((resolve) => {
      settle = resolve
    })
    return { promise, settle }
  }

  it('dials only once the server listens and then sends what was asked meanwhile', async () => {
    const server = listening()
    const transport = new Transport('ws://127.0.0.1:4311', { serverListening: server.promise })
    const states: string[] = []
    transport.onState((state) => states.push(state))
    transport.connect()
    const pending = transport.request('projects.list', {})
    await vi.advanceTimersByTimeAsync(1_000)
    expect(Socket.instances).toHaveLength(0)
    expect(transport.state).toBe('connecting')

    server.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(Socket.instances).toHaveLength(1)
    const socket = Socket.instances[0]!
    socket.open()
    const request = JSON.parse(socket.sent.find((frame) => frame.includes('projects.list'))!) as {
      id: string
    }
    socket.onmessage?.({ data: JSON.stringify({ id: request.id, result: { projects: [] } }) })
    await expect(pending).resolves.toEqual({ projects: [] })
    expect(states).toEqual(['connecting', 'open'])
    await vi.advanceTimersByTimeAsync(OWN_SERVER_LISTEN_WAIT_MS)
    expect(Socket.instances).toHaveLength(1)
    transport.close()
  })

  it('dials anyway when no answer comes', async () => {
    const transport = new Transport('ws://127.0.0.1:4311', {
      serverListening: new Promise<never>(() => undefined),
    })
    transport.connect()
    await vi.advanceTimersByTimeAsync(OWN_SERVER_LISTEN_WAIT_MS - 1)
    expect(Socket.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(Socket.instances).toHaveLength(1)
    transport.close()
  })

  it('dials nothing after close, and waits only before the first socket', async () => {
    const server = listening()
    const transport = new Transport('ws://127.0.0.1:4311', { serverListening: server.promise })
    transport.connect()
    transport.close()
    server.settle()
    await vi.advanceTimersByTimeAsync(OWN_SERVER_LISTEN_WAIT_MS)
    expect(Socket.instances).toHaveLength(0)
    expect(transport.state).toBe('closed')

    transport.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(Socket.instances).toHaveLength(1)
    Socket.instances[0]!.open()
    Socket.instances[0]!.close()
    expect(transport.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(Socket.instances).toHaveLength(2)
    transport.close()
  })
})
