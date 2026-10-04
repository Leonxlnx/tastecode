import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  LineBuffer,
  readNdjson,
  readSseData,
  StdioJsonRpc,
  type StdioJsonRpcProcess,
} from './index.js'

function rpcChild(): StdioJsonRpcProcess {
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

describe('bounded protocol frames', () => {
  it('accepts normal large payloads and limits each frame rather than the chunk', () => {
    const lines = new LineBuffer(2 * 1024 * 1024)
    const payload = JSON.stringify({ value: 'x'.repeat(1024 * 1024) })
    const values: string[] = []
    lines.write(`${payload}\n${payload}\n${payload}\n`, (line) => values.push(line))
    expect(values).toEqual([payload, payload, payload])
  })

  it('rejects an unfinished NDJSON line once and never dispatches its remainder', () => {
    const stdout = new PassThrough()
    const error = vi.fn()
    const value = vi.fn()
    readNdjson(stdout, value, undefined, { maxFrameBytes: 16, onError: error })
    stdout.write('{"data":"')
    stdout.write('x'.repeat(16))
    stdout.end('"}\n{"valid":true}\n')
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0].message).toContain('frame exceeds')
    expect(value).not.toHaveBeenCalled()
  })

  it('rejects pending JSON-RPC requests and stops the peer on an oversized frame', async () => {
    const child = rpcChild()
    const rpc = new StdioJsonRpc(child, 'test', { maxFrameBytes: 32 })
    const pending = rpc.request('waiting')
    const rejected = expect(pending).rejects.toThrow('frame exceeds')
    child.stdout.emit('data', '{"data":"')
    child.stdout.emit('data', 'x'.repeat(32))
    await rejected
    expect(child.kill).toHaveBeenCalled()
    await expect(rpc.request('later')).rejects.toThrow('frame exceeds')
    await rpc.dispose()
  })

  it('limits the combined SSE event, including endless small data lines', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('data: x\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(Array.fromAsync(readSseData(body, 32))).rejects.toThrow('frame exceeds')
    expect(cancelled).toBe(true)
  })

  it('rejects an unfinished SSE tail after complete lines reach the frame cap', async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: 12345678\ndata: 12345678'))
        },
      })
    await expect(Array.fromAsync(readSseData(stream(), 24))).rejects.toThrow('frame exceeds')
  })

  it('cancels SSE on early consumer exit and parses an unterminated final event', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const data of readSseData(body)) {
      expect(data).toBe('one')
      break
    }
    expect(cancelled).toBe(true)
    const final = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: last'))
        controller.close()
      },
    })
    await expect(Array.fromAsync(readSseData(final))).resolves.toEqual(['last'])
  })
})
