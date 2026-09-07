import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer } from './server.js'

type RpcResponse = {
  id?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function openSocket(port: number): Promise<{
  socket: WebSocket
  request: (id: string, method: string, params: unknown) => Promise<RpcResponse>
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  // Buffer from the first tick: pushes (like server.welcome) can arrive
  // before any reply is awaited, and broadcasts must not be mistaken for one.
  const inbox: RpcResponse[] = []
  const waiters = new Map<string, (response: RpcResponse) => void>()
  socket.on('message', (raw) => {
    let message: RpcResponse
    try {
      message = JSON.parse(raw.toString()) as RpcResponse
    } catch {
      return
    }
    const waiter = typeof message.id === 'string' ? waiters.get(message.id) : undefined
    if (waiter) {
      waiters.delete(message.id as string)
      waiter(message)
    } else {
      inbox.push(message)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const request = (id: string, method: string, params: unknown): Promise<RpcResponse> => {
    const buffered = inbox.findIndex((message) => message.id === id)
    const reply =
      buffered >= 0
        ? Promise.resolve(inbox.splice(buffered, 1)[0] as RpcResponse)
        : new Promise<RpcResponse>((resolve) => {
            waiters.set(id, resolve)
          })
    socket.send(JSON.stringify({ id, method, params }))
    return reply
  }
  return { socket, request }
}

const previousDataDir = process.env['HARNESS_DATA_DIR']
let temporaryDirectory: string | undefined

afterEach(() => {
  if (previousDataDir === undefined) delete process.env['HARNESS_DATA_DIR']
  else process.env['HARNESS_DATA_DIR'] = previousDataDir
  if (temporaryDirectory !== undefined) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('usage.history requests', () => {
  it('rejects an unknown range instead of passing it to the history scan', async () => {
    temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'harness-usage-history-request-'))
    process.env['HARNESS_DATA_DIR'] = temporaryDirectory
    const server = startServer({ port: await freePort() })
    const { socket, request } = await openSocket(server.port)
    try {
      const rejected = await request('bad-range', 'usage.history', { range: 'bogus' })
      expect(rejected.id).toBe('bad-range')
      expect(rejected.error?.code).toBe('bad_request')

      const accepted = await request('ok-range', 'usage.history', { range: '7d' })
      expect(accepted.id).toBe('ok-range')
      expect(accepted.error).toBeUndefined()
      expect((accepted.result as { range?: unknown }).range).toBe('7d')
    } finally {
      socket.close()
      await server.close()
    }
  })
})
