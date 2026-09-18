import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { classifyPortResponse, parsePortConflict, probePortOwner } from './server-port-conflict.js'

describe('parsePortConflict', () => {
  it('extracts the port from the server bind error', () => {
    expect(
      parsePortConflict(
        '[server] port 4311 is already in use — another TasteCode server is probably still running. Stop it, or set HARNESS_PORT to a free port.',
      ),
    ).toBe(4311)
  })

  it('ignores unrelated log lines', () => {
    expect(parsePortConflict('[server] listening on ws://127.0.0.1:4311')).toBeUndefined()
    expect(parsePortConflict('port is already taken')).toBeUndefined()
    expect(parsePortConflict('port 99999 is already in use')).toBeUndefined()
  })
})

describe('classifyPortResponse', () => {
  it('treats 426 as the core server fingerprint', () => {
    expect(classifyPortResponse(426)).toBe('harness')
  })

  it('treats any other answered status as foreign', () => {
    expect(classifyPortResponse(200)).toBe('foreign')
    expect(classifyPortResponse(404)).toBe('foreign')
  })

  it('treats no answer as unknown', () => {
    expect(classifyPortResponse(undefined)).toBe('unknown')
  })
})

describe('probePortOwner', () => {
  async function withServer(
    statusCode: number,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = createServer((_req, res) => {
      res.writeHead(statusCode)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no address')
      await run(address.port)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('identifies a harness-compatible listener', async () => {
    await withServer(426, async (port) => {
      expect(await probePortOwner('127.0.0.1', port)).toBe('harness')
    })
  })

  it('identifies a foreign listener', async () => {
    await withServer(200, async (port) => {
      expect(await probePortOwner('127.0.0.1', port)).toBe('foreign')
    })
  })

  it('reports unknown when nothing answers', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const port = address.port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await probePortOwner('127.0.0.1', port, 500)).toBe('unknown')
  })
})
