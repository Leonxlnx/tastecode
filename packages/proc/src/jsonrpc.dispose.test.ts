import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { StdioJsonRpcProcess } from './jsonrpc.js'

const killTree = vi.hoisted(() => vi.fn<(child: unknown) => Promise<void>>())
vi.mock('./kill.js', () => ({ killTree }))

const { StdioJsonRpc } = await import('./jsonrpc.js')

function child(): StdioJsonRpcProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: undefined,
    kill: vi.fn(() => true),
  })
}

describe('JSON-RPC process stop', () => {
  it('stops again after a failed stop instead of returning that failure forever', async () => {
    killTree
      .mockRejectedValueOnce(new Error('Child process did not exit after forced termination'))
      .mockResolvedValueOnce(undefined)
    const rpc = new StdioJsonRpc(child(), 'test agent')

    await expect(rpc.dispose()).rejects.toThrow('did not exit after forced termination')
    await expect(rpc.dispose()).resolves.toBeUndefined()
    // A finished stop is shared, not repeated.
    await expect(rpc.dispose()).resolves.toBeUndefined()
    expect(killTree).toHaveBeenCalledTimes(2)
    await expect(rpc.request('late')).rejects.toThrow('transport disposed')
  })

  it('shares one stop between concurrent callers', async () => {
    killTree.mockReset()
    let finish!: () => void
    killTree.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)))
    const rpc = new StdioJsonRpc(child(), 'test agent')

    const first = rpc.dispose()
    expect(rpc.dispose()).toBe(first)
    finish()
    await first
    expect(killTree).toHaveBeenCalledOnce()
  })
})
