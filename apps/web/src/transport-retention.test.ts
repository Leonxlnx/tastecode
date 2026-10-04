// @vitest-environment happy-dom
import { setImmediate } from 'node:timers'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class Socket {
  static instances: Socket[] = []
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
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

const parseJSON = JSON.parse
let replies: WeakRef<object>[] = []

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('WebSocket', Socket)
  Socket.instances = []
  replies = []
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    const parsed = parseJSON(...args) as { result?: { marker?: string } }
    if (parsed?.result?.marker?.startsWith('discarded')) replies.push(new WeakRef(parsed.result))
    return parsed
  }
})

afterEach(() => {
  JSON.parse = parseJSON
  vi.doUnmock('./transport-validation.js')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A WeakRef proves release before the lazy import settles, rather than only
 * checking a rejected caller while an import callback still retains its data. */
async function collectDiscardedReplies(): Promise<void> {
  setFlagsFromString('--expose_gc')
  const collect = runInNewContext('gc') as () => void
  setFlagsFromString('--noexpose_gc')
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    collect()
  }
}

describe('deferred response validation ownership', () => {
  it.each(['disconnect', 'timeout', 'close'] as const)(
    'releases old reply values after %s across repeated reconnects',
    async (ending) => {
      let release!: (module: object) => void
      const loading = new Promise<object>((resolve) => {
        release = resolve
      })
      vi.doMock('./transport-validation.js', () => loading)
      const { Transport, TRANSPORT_LIMITS, IndeterminateRequestError } =
        await import('./transport.js')
      const parse = vi.fn((_method: string, value: unknown) => value)
      const transport = new Transport('ws://127.0.0.1:4311')
      transport.connect()
      const reply = (socket: Socket, marker: string) => {
        const request = parseJSON(
          socket.sent.findLast((frame) => frame.includes('thread.history'))!,
        ) as { id: string }
        socket.onmessage?.({
          data: JSON.stringify({
            id: request.id,
            result: { marker, payload: 'x'.repeat(1_000_000) },
          }),
        })
      }
      try {
        for (let generation = 0; generation < 3; generation += 1) {
          const socket = Socket.instances.at(-1)!
          socket.open()
          const pending = transport
            .request('thread.history', { threadId: 'thread' })
            .catch((error: unknown) => error)
          reply(socket, `discarded-${generation}`)
          if (ending === 'timeout') {
            await vi.advanceTimersByTimeAsync(TRANSPORT_LIMITS.requestTimeoutMs + 1)
          } else if (ending === 'close') {
            transport.close()
            transport.connect()
          } else {
            socket.close()
            await vi.advanceTimersByTimeAsync(1)
          }
          expect(await pending).toBeInstanceOf(IndeterminateRequestError)
        }
        await collectDiscardedReplies()
        expect(replies).toHaveLength(3)
        expect(replies.map((reference) => reference.deref())).toEqual([
          undefined,
          undefined,
          undefined,
        ])
        expect(parse).not.toHaveBeenCalled()
        const socket = Socket.instances.at(-1)!
        socket.open()
        const fresh = transport.request('thread.history', { threadId: 'thread' })
        reply(socket, 'fresh')
        release({ parseMethodResult: parse })
        await expect(fresh).resolves.toMatchObject({ marker: 'fresh' })
        expect(parse).toHaveBeenCalledOnce()
      } finally {
        transport.close()
        release({ parseMethodResult: parse })
      }
    },
  )
})
