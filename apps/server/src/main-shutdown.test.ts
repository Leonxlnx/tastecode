import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ close: vi.fn() }))
vi.mock('./server.js', () => ({
  DEFAULT_PORT: 4311,
  startServer: () => ({ close: mocks.close }),
}))

const handlers = new Map<string, (...args: unknown[]) => void>()
const parentPort = new EventEmitter()
let originalParentPort: PropertyDescriptor | undefined

beforeEach(() => {
  vi.resetModules()
  mocks.close.mockReset().mockResolvedValue(undefined)
  handlers.clear()
  parentPort.removeAllListeners()
  originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort')
  Object.defineProperty(process, 'parentPort', { configurable: true, value: parentPort })
  vi.spyOn(process, 'on').mockImplementation(((
    name: string,
    listener: (...args: unknown[]) => void,
  ) => {
    handlers.set(name, listener)
    return process
  }) as typeof process.on)
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalParentPort) Object.defineProperty(process, 'parentPort', originalParentPort)
  else Reflect.deleteProperty(process, 'parentPort')
})

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const message = { type: 'harness:shutdown' }

describe('server main shutdown', () => {
  it.each(['SIGINT', 'SIGTERM', 'node', 'utility'])(
    'waits for recorded-delta flush and store close before exiting through %s',
    async (source) => {
      const events: string[] = []
      let finish!: () => void
      const closed = new Promise<void>((resolve) => {
        finish = resolve
      })
      mocks.close.mockImplementation(async () => {
        events.push('flush deltas')
        await closed
        events.push('close store')
      })
      vi.mocked(process.exit).mockImplementation(() => {
        events.push('exit')
        return undefined as never
      })
      await import('./main.js')
      if (source === 'utility') parentPort.emit('message', { data: message })
      else if (source === 'node') handlers.get('message')!(message)
      else handlers.get(source)!()
      await settle()
      expect(events).toEqual(['flush deltas'])
      expect(process.exit).not.toHaveBeenCalled()
      finish()
      await settle()
      expect(events).toEqual(['flush deltas', 'close store', 'exit'])
      expect(process.exit).toHaveBeenCalledWith(0)
    },
  )

  it('coalesces duplicate signals and both IPC channels into one shutdown', async () => {
    let finish!: () => void
    mocks.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    await import('./main.js')
    handlers.get('message')!(message)
    parentPort.emit('message', { data: message })
    handlers.get('SIGTERM')!()
    handlers.get('SIGINT')!()
    await settle()
    expect(mocks.close).toHaveBeenCalledOnce()
    finish()
    await settle()
    handlers.get('message')!(message)
    expect(process.exit).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('rejects malformed, extra-field and inherited-type shutdown requests', async () => {
    await import('./main.js')
    for (const invalid of [
      null,
      'harness:shutdown',
      [],
      {},
      { type: 'other' },
      { type: 'harness:shutdown', extra: true },
      Object.create(message),
    ]) {
      handlers.get('message')!(invalid)
      parentPort.emit('message', { data: invalid })
    }
    await settle()
    expect(mocks.close).not.toHaveBeenCalled()
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('reports a close failure and exits nonzero without an unhandled rejection', async () => {
    const error = new Error('Store close failed')
    mocks.close.mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await import('./main.js')
    handlers.get('SIGTERM')!()
    await settle()
    expect(log).toHaveBeenCalledWith('[server] shutdown failed', error)
    expect(process.exit).toHaveBeenCalledWith(1)
  })
})
