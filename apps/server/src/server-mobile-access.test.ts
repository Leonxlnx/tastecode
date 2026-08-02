import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { methods } from '@harness/contracts'
import { WebSocket } from 'ws'
import { startServer } from './server.js'

const FAKE_INTERFACES = {
  tailscale0: [
    {
      address: '100.101.22.33',
      netmask: '255.192.0.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: '100.101.22.33/10',
    },
  ],
  en0: [
    {
      address: '192.168.1.44',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.44/24',
    },
  ],
}

const previousDataDir = process.env['HARNESS_DATA_DIR']

afterEach(() => {
  if (previousDataDir === undefined) delete process.env['HARNESS_DATA_DIR']
  else process.env['HARNESS_DATA_DIR'] = previousDataDir
})

describe('server mobile trust boundary', () => {
  it('keeps QR sockets bootstrap-only and device sockets outside desktop administration', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'harness-mobile-server-'))
    process.env['HARNESS_DATA_DIR'] = dataDir
    const port = await availablePort()
    const server = startServer({
      port,
      accessToken: 'desktop-admin',
      mobilePort: 0,
      mobileNetworkInterfaces: () => FAKE_INTERFACES,
      resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
    })
    const sockets = new Set<WebSocket>()
    let attachmentPath: string | undefined

    try {
      await waitForPort(port)
      const admin = await openSocket(
        sockets,
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent('desktop-admin')}`,
      )
      const offer = methods['connections.startPairing'].result.parse(
        await request(admin, 'pair', 'connections.startPairing', {}),
      )

      const pairingTicket = decodePairingTicket(offer.pairingUri)
      const bootstrap = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?pairing_ticket=${encodeURIComponent(pairingTicket)}`,
      )
      await expect(request(bootstrap, 'pairing-denied', 'projects.list', {})).rejects.toThrow(
        '[forbidden]',
      )

      const claimed = methods['connections.claim'].result.parse(
        await request(bootstrap, 'claim', 'connections.claim', { name: 'Integration iPhone' }),
      )
      bootstrap.close()

      const device = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
      )
      await expect(
        request(device, 'device-status', 'connections.deviceStatus', {}),
      ).resolves.toMatchObject({
        serverName: expect.any(String),
        addresses: offer.addresses,
      })
      await expect(request(device, 'device-denied', 'connections.status', {})).rejects.toThrow(
        '[forbidden]',
      )
      await expect(request(device, 'device-projects', 'projects.list', {})).resolves.toEqual({
        projects: [],
      })
      const attachment = methods['attachments.saveFile'].result.parse(
        await request(device, 'device-attachment', 'attachments.saveFile', {
          name: 'reference.txt',
          mimeType: 'text/plain',
          data: Buffer.from('from phone').toString('base64'),
        }),
      )
      attachmentPath = attachment.path
      expect(readFileSync(attachment.path, 'utf8')).toBe('from phone')
      await expect(
        request(device, 'device-rename', 'thread.rename', {
          threadId: 'missing-thread',
          title: 'Mobile-created thread',
        }),
      ).resolves.toEqual({})

      const deviceClose = once(device, 'close')
      await request(admin, 'revoke', 'connections.revoke', { deviceId: claimed.deviceId })
      const [closeCode] = (await deviceClose) as [number, Buffer]
      expect(closeCode).toBe(1006)
    } finally {
      for (const socket of sockets) socket.terminate()
      await server.close()
      if (attachmentPath) rmSync(attachmentPath, { force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

async function availablePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not reserve test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`server did not open port ${port}`)
}

async function openSocket(sockets: Set<WebSocket>, url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  const welcome = once(socket, 'message')
  await once(socket, 'open')
  await welcome
  return socket
}

async function request(
  socket: WebSocket,
  id: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const response = new Promise<unknown>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const parsed = JSON.parse(asText(raw)) as
        | { id: string; result: unknown }
        | { id: string; error: { code: string; message: string } }
        | { channel: string }
      if ('channel' in parsed || parsed.id !== id) return
      socket.off('message', onMessage)
      if ('error' in parsed) {
        reject(new Error(`[${parsed.error.code}] ${parsed.error.message}`))
        return
      }
      resolve(parsed.result)
    }
    socket.on('message', onMessage)
  })
  socket.send(JSON.stringify({ id, method, params }))
  return response
}

function decodePairingTicket(pairingUri: string): string {
  const encoded = new URL(pairingUri).searchParams.get('payload')
  if (!encoded) throw new Error('missing pairing payload')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket: string }
  return payload.ticket
}

function asText(raw: unknown): string {
  return Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw as ArrayBufferLike).toString()
}
