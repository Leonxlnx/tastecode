// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  vi.doUnmock('./transport-validation.js')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('validator module failures', () => {
  it('keeps a replied mutation indeterminate if its validator cannot load', async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('WebSocket', Socket)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let rejectLoad!: (error: Error) => void
    const loading = new Promise<object>((_resolve, reject) => {
      rejectLoad = reject
    })
    vi.doMock('./transport-validation.js', () => loading)
    const { Transport, IndeterminateRequestError, TRANSPORT_LIMITS } =
      await import('./transport.js')
    const transport = new Transport('ws://127.0.0.1:4311')
    const onEvent = vi.fn()
    transport.on('thread.event', onEvent)
    transport.connect()
    const socket = Socket.instances.at(-1)!
    socket.open()
    const pending = transport.request('thread.sendTurn', { threadId: 'thread', text: 'Only once' })
    const frame = JSON.parse(socket.sent.find((value) => value.includes('thread.sendTurn'))!) as {
      id: string
    }
    socket.onmessage?.({ data: JSON.stringify({ id: frame.id, result: {} }) })
    socket.onmessage?.({
      data: JSON.stringify({
        channel: 'thread.event',
        sequence: 1,
        data: {
          threadId: 'thread',
          event: { type: 'turn.completed', turnId: 'turn', status: 'completed' },
        },
      }),
    })
    const result = pending.catch((error: unknown) => error)
    try {
      rejectLoad(new Error('Failed to fetch dynamically imported module'))
      expect(await result).toBeInstanceOf(IndeterminateRequestError)
      expect(await result).toHaveProperty('message', expect.stringContaining('Restart TasteCode'))
      expect(await result).toHaveProperty('message', expect.stringContaining('may have completed'))
      expect(onEvent).not.toHaveBeenCalled()
      expect(transport.state).toBe('reconnecting')
      expect(socket.readyState).toBe(Socket.CLOSED)
      await vi.advanceTimersByTimeAsync(1)
      const next = Socket.instances.at(-1)!
      next.open()
      expect(next.sent.some((value) => value.includes('thread.sendTurn'))).toBe(false)
      transport.close()
      await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs)
    } finally {
      transport.close()
    }
  })
})
