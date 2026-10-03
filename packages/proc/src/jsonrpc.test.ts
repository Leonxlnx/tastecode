import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StdioJsonRpc, type ServerRequestHandler, type StdioJsonRpcProcess } from './jsonrpc.js'

const transports: StdioJsonRpc[] = []

function child(stdin: Writable = new PassThrough()) {
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: undefined,
    kill: vi.fn(() => true),
  }) satisfies StdioJsonRpcProcess
}

function transport(
  process: StdioJsonRpcProcess,
  options: ConstructorParameters<typeof StdioJsonRpc>[2] = {},
) {
  const rpc = new StdioJsonRpc(process, 'test agent', options)
  transports.push(rpc)
  return rpc
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((rpc) => rpc.dispose()))
  vi.restoreAllMocks()
})

describe('JSON-RPC input failures', () => {
  it('rejects all calls after an asynchronous write error and reports one failure', async () => {
    const error = new Error('write EPIPE')
    const process = child(
      new Writable({
        write(_chunk, _encoding, callback) {
          queueMicrotask(() => callback(error))
        },
      }),
    )
    const failure = vi.fn()
    const protocolError = vi.fn()
    const rpc = transport(process, { onFailure: failure, onProtocolError: protocolError })
    const log = vi.fn()
    rpc.onStderr(log)
    const pending = [
      rpc.request('first', {}, { timeoutMs: 10_000 }).catch((cause: unknown) => cause),
      rpc.request('second').catch((cause: unknown) => cause),
    ]

    expect(await Promise.all(pending)).toEqual([error, error])
    await expect(rpc.request('later')).rejects.toBe(error)
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
    expect(protocolError).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith('stdin: Error: write EPIPE')
    expect(process.kill).toHaveBeenCalledTimes(1)

    const stopped = rpc.dispose()
    expect(rpc.dispose()).toBe(stopped)
    await stopped
    process.emit('close', 1)
    process.stdin.emit('error', error)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(process.kill).toHaveBeenCalledTimes(1)
  })

  it.each(['end', 'destroy'] as const)(
    'fails pending and new calls when stdin is already closed by %s',
    async (close) => {
      const process = child()
      const failure = vi.fn()
      const rpc = transport(process, { onFailure: failure })
      const pending = rpc.request('pending').catch((error: unknown) => error)
      process.stdin[close]()

      await expect(rpc.request('next')).rejects.toThrow('test agent input stream is not writable')
      expect(await pending).toBe(failure.mock.calls[0]?.[0])
      expect(failure).toHaveBeenCalledTimes(1)
      expect(process.kill).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['request', 'notification'] as const)(
    'fails the transport when a %s write throws synchronously',
    async (kind) => {
      const process = child()
      const failure = vi.fn()
      const rpc = transport(process, { onFailure: failure })
      const pending = rpc.request('pending').catch((error: unknown) => error)
      const error = new Error('write failed')
      const write = vi.spyOn(process.stdin, 'write').mockImplementation(() => {
        throw error
      })

      if (kind === 'request') await expect(rpc.request('next')).rejects.toBe(error)
      else expect(() => rpc.notify('cancel')).not.toThrow()
      expect(await pending).toBe(error)
      expect(failure).toHaveBeenCalledExactlyOnceWith(error)
      rpc.notify('later')
      expect(write).toHaveBeenCalledTimes(1)
    },
  )

  it('reports a failed notification write even when no calls are pending', async () => {
    const error = new Error('write EPIPE')
    const process = child()
    const failure = vi.fn()
    const rpc = transport(process, { onFailure: failure })
    process.stdin.end()

    expect(() => rpc.notify('cancel')).not.toThrow()
    expect(failure).toHaveBeenCalledTimes(1)
    process.stdin.emit('error', error)
    await expect(rpc.request('later')).rejects.toThrow('input stream is not writable')
    expect(failure).toHaveBeenCalledTimes(1)
  })
})

describe('JSON-RPC failure lifecycle', () => {
  it.each([false, true])(
    'still stops a failed process when its observer throws (logger throws: %s)',
    async (loggerThrows) => {
      const process = child()
      const error = new Error('write EPIPE')
      const failure = vi.fn(() => {
        throw new Error('downstream listener failed')
      })
      const rpc = transport(process, { onFailure: failure })
      const log = vi.fn(() => {
        if (loggerThrows) throw new Error('logger failed')
      })
      rpc.onStderr(log)
      const rejected = vi.fn((cause: unknown) => cause)
      const pending = rpc.request('pending').catch(rejected)

      expect(() => process.stdin.emit('error', error)).not.toThrow()
      expect(await pending).toBe(error)
      expect(rejected).toHaveBeenCalledExactlyOnceWith(error)
      expect(failure).toHaveBeenCalledExactlyOnceWith(error)
      expect(process.kill).toHaveBeenCalledTimes(1)
      expect(log.mock.calls).toEqual([
        ['failure handler failed: Error: downstream listener failed'],
        ['stdin: Error: write EPIPE'],
      ])
      await rpc.dispose()
      process.emit('close', 1)
      process.stdin.emit('error', error)
      expect(failure).toHaveBeenCalledTimes(1)
      expect(process.kill).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledTimes(2)
    },
  )

  it('contains throwing failure observers on process close', async () => {
    const process = child()
    const failure = vi.fn(() => {
      throw new Error('downstream listener failed')
    })
    const rpc = transport(process, { onFailure: failure })
    const pending = rpc.request('pending').catch((error: unknown) => error)

    expect(() => process.emit('close', 1)).not.toThrow()
    expect(await pending).toEqual(new Error('test agent exited (code 1)'))
    expect(failure).toHaveBeenCalledTimes(1)
  })

  it('still stops a broken protocol when both failure observers throw', async () => {
    const process = child()
    const failObserver = () => {
      throw new Error('downstream listener failed')
    }
    const failure = vi.fn(failObserver)
    const protocolError = vi.fn(failObserver)
    const rpc = transport(process, {
      maxFrameBytes: 16,
      onFailure: failure,
      onProtocolError: protocolError,
    })
    const pending = rpc.request('pending').catch((error: unknown) => error)

    expect(() => process.stdout.write('x'.repeat(17))).not.toThrow()
    const error = await pending
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
    expect(protocolError).toHaveBeenCalledExactlyOnceWith(error)
    expect(process.kill).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1])('reports unexpected process close with code %s exactly once', async (code) => {
    const process = child()
    const failure = vi.fn()
    const rpc = transport(process, { onFailure: failure })
    const pending = rpc.request('pending').catch((error: unknown) => error)

    process.emit('close', code)
    const error = await pending
    expect(error).toEqual(new Error(`test agent exited (code ${code})`))
    await expect(rpc.request('later')).rejects.toBe(error)
    process.emit('error', new Error('late process error'))
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('reports process errors before close and keeps the first failure', async () => {
    const process = child()
    const failure = vi.fn()
    const rpc = transport(process, { onFailure: failure })
    const pending = rpc.request('pending').catch((error: unknown) => error)
    const error = new Error('spawn failed')

    process.emit('error', error)
    expect(await pending).toBe(error)
    process.emit('close', 1)
    await expect(rpc.request('later')).rejects.toBe(error)
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('drains existing replies after exit while refusing new requests and notifications', async () => {
    const process = child()
    const failure = vi.fn()
    const rpc = transport(process, { onFailure: failure })
    const write = vi.spyOn(process.stdin, 'write')
    const pending = rpc.request('final')

    process.exitCode = 0
    process.emit('exit', 0)
    await expect(rpc.request('late')).rejects.toThrow('test agent has exited')
    rpc.notify('late')
    expect(write).toHaveBeenCalledTimes(1)
    process.stdout.write('{"jsonrpc":"2.0","id":1,"result":"drained"}\n')
    await expect(pending).resolves.toBe('drained')
    expect(failure).not.toHaveBeenCalled()
    process.emit('close', 0)
    expect(failure).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy protocol errors and reports the same failure once', async () => {
    const process = child()
    const failure = vi.fn()
    const protocolError = vi.fn()
    const rpc = transport(process, {
      maxFrameBytes: 16,
      onFailure: failure,
      onProtocolError: protocolError,
    })
    const pending = rpc.request('pending').catch((error: unknown) => error)

    process.stdout.write('x'.repeat(17))
    const error = await pending
    expect(failure).toHaveBeenCalledExactlyOnceWith(error)
    expect(protocolError).toHaveBeenCalledExactlyOnceWith(error)
    process.emit('close', 1)
    expect(failure).toHaveBeenCalledTimes(1)
  })

  it('does not report intentional disposal or its late stream errors as failures', async () => {
    const process = child()
    const failure = vi.fn()
    const rpc = transport(process, { onFailure: failure })
    const pending = rpc.request('pending').catch((error: unknown) => error)
    const stopped = rpc.dispose()
    expect(rpc.dispose()).toBe(stopped)
    await stopped
    expect(await pending).toEqual(new Error('transport disposed'))

    process.stdin.emit('error', new Error('late EPIPE'))
    process.emit('error', new Error('late process error'))
    process.emit('close', 0)
    rpc.notify('late')
    await expect(rpc.request('late')).rejects.toThrow('transport disposed')
    expect(failure).not.toHaveBeenCalled()
    expect(process.kill).toHaveBeenCalledTimes(1)
  })
})

describe('JSON-RPC incoming request identity', () => {
  it.each([0, 7, 'approval-1'])('passes request id %s without changing the response', (id) => {
    const process = child()
    const rpc = transport(process)
    const write = vi.spyOn(process.stdin, 'write')
    const handler = vi.fn<ServerRequestHandler>((_method, _params, respond, _requestId) =>
      respond({ accepted: true }),
    )
    rpc.onServerRequest(handler)

    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'approve', params: {} })}\n`,
    )

    expect(handler).toHaveBeenCalledWith('approve', {}, expect.any(Function), id)
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      jsonrpc: '2.0',
      id,
      result: { accepted: true },
    })
  })
})
