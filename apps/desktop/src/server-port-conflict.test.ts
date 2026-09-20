import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'

import { PROTOCOL_VERSION } from '@harness/contracts'
import { describe, expect, it } from 'vitest'

import {
  classifyPortResponse,
  parsePortConflict,
  probePortOwner,
  welcomeProtocolVersion,
} from './server-port-conflict.js'

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

describe('welcomeProtocolVersion', () => {
  it('reads the version out of a server.welcome frame', () => {
    expect(
      welcomeProtocolVersion({
        channel: 'server.welcome',
        sequence: 1,
        data: { serverVersion: '0.0.0', protocolVersion: PROTOCOL_VERSION },
      }),
    ).toBe(PROTOCOL_VERSION)
  })

  it('rejects other channels and malformed frames', () => {
    expect(welcomeProtocolVersion({ channel: 'thread.event', data: {} })).toBeUndefined()
    expect(welcomeProtocolVersion({ channel: 'server.welcome' })).toBeUndefined()
    expect(
      welcomeProtocolVersion({ channel: 'server.welcome', data: { protocolVersion: 'two' } }),
    ).toBeUndefined()
    expect(welcomeProtocolVersion('server.welcome')).toBeUndefined()
    expect(welcomeProtocolVersion(null)).toBeUndefined()
  })
})

function welcomeFrame(protocolVersion: number): string {
  return JSON.stringify({
    channel: 'server.welcome',
    sequence: 1,
    data: { serverVersion: '0.0.0', protocolVersion },
  })
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Server→client text frames are unmasked: opcode byte, then the length. */
function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload)
  const header =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
  return Buffer.concat([header, body])
}

describe('probePortOwner', () => {
  type SocketBehavior = { kind: 'frame'; frame: string } | { kind: 'reject' } | { kind: 'silent' }

  async function withListener(
    statusCode: number,
    socketBehavior: SocketBehavior | undefined,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const sockets = new Set<Socket>()
    const server = createServer((_req, res) => {
      res.writeHead(statusCode)
      res.end()
    })
    server.on('upgrade', (req, socket: Socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      if (socketBehavior === undefined || socketBehavior.kind === 'reject') {
        socket.destroy()
        return
      }
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}${WS_GUID}`)
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      if (socketBehavior.kind === 'frame') socket.write(textFrame(socketBehavior.frame))
      // 'silent' leaves the socket open without pushing anything.
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no address')
      await run(address.port)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('adopts a listener that greets with the matching protocol version', async () => {
    await withListener(
      426,
      { kind: 'frame', frame: welcomeFrame(PROTOCOL_VERSION) },
      async (port) => {
        expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION)).toBe('harness')
      },
    )
  })

  it('refuses a listener whose welcome names another protocol version', async () => {
    await withListener(
      426,
      { kind: 'frame', frame: welcomeFrame(PROTOCOL_VERSION + 1) },
      async (port) => {
        expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION)).toBe('foreign')
      },
    )
  })

  it('refuses a socket that pushes something other than server.welcome', async () => {
    await withListener(
      426,
      { kind: 'frame', frame: JSON.stringify({ hello: 'world' }) },
      async (port) => {
        expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION)).toBe('foreign')
      },
    )
    await withListener(426, { kind: 'frame', frame: 'not json' }, async (port) => {
      expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION)).toBe('foreign')
    })
  })

  it('stays unknown when the WebSocket handshake never produces a frame', async () => {
    await withListener(426, { kind: 'reject' }, async (port) => {
      expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION, 300)).toBe('unknown')
    })
    await withListener(426, { kind: 'silent' }, async (port) => {
      expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION, 300)).toBe('unknown')
    })
  })

  it('identifies a foreign listener', async () => {
    await withListener(200, undefined, async (port) => {
      expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION)).toBe('foreign')
    })
  })

  it('reports unknown when nothing answers', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const port = address.port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await probePortOwner('127.0.0.1', port, PROTOCOL_VERSION, 500)).toBe('unknown')
  })
})
