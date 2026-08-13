import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { methods } from '@harness/contracts'
import { WebSocket } from 'ws'
import { startServer } from './server.js'

const INTERFACES = {
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
}

const WEB_TOKEN = 'web-token-for-tests'

const previousDataDir = process.env['HARNESS_DATA_DIR']

afterEach(() => {
  if (previousDataDir === undefined) delete process.env['HARNESS_DATA_DIR']
  else process.env['HARNESS_DATA_DIR'] = previousDataDir
})

describe('server mobile trust boundary', () => {
  it('keeps pairing sockets bootstrap-only and devices outside administration', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'harness-mobile-server-'))
    const projectBrowserHome = path.join(dataDir, 'home')
    const browsableProject = path.join(projectBrowserHome, 'Developer', 'harness')
    mkdirSync(browsableProject, { recursive: true })
    const canonicalProjectBrowserHome = realpathSync(projectBrowserHome)
    const canonicalBrowsableProject = realpathSync(browsableProject)
    process.env['HARNESS_DATA_DIR'] = dataDir
    const port = await availablePort()
    const server = startServer({
      port,
      accessToken: 'desktop-admin',
      mobilePort: 0,
      mobileNetworkInterfaces: () => INTERFACES,
      resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
      webToken: WEB_TOKEN,
      webRoot: await fixtureWebApp(),
      webDevServerProbeUrl: false,
      projectBrowserHome: canonicalProjectBrowserHome,
    })
    const sockets = new Set<WebSocket>()
    let attachmentPath: string | undefined

    try {
      const admin = await openSocket(
        sockets,
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent('desktop-admin')}`,
      )
      const offer = methods['connections.startPairing'].result.parse(
        await request(admin, 'pair', 'connections.startPairing', {}),
      )
      expect(offer.webUrls).toEqual([
        `http://100.101.22.33:${offer.port}/#access_token=${WEB_TOKEN}`,
      ])

      // The web app (the full harness UI on a phone) is served at the root
      // without a token gate — the token lives in the hash and gates the socket.
      const appPage = await fetch(`http://127.0.0.1:${offer.port}/`)
      expect(appPage.status).toBe(200)
      expect(await appPage.text()).toContain('fixture-app-marker')

      // Its socket authenticates as a full admin client.
      const webClient = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/ws?token=${encodeURIComponent(WEB_TOKEN)}`,
      )
      await expect(request(webClient, 'projects', 'projects.list', {})).resolves.toEqual({
        projects: [],
      })
      const statusAsAdmin = methods['connections.status'].result.parse(
        await request(webClient, 'status', 'connections.status', {}),
      )
      expect(statusAsAdmin.webUrls.length).toBe(1)

      const bootstrap = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?pairing_ticket=${encodeURIComponent(pairingTicket(offer.pairingUri))}`,
      )
      await expect(request(bootstrap, 'denied', 'projects.list', {})).rejects.toThrow('[forbidden]')

      const claimed = methods['connections.claim'].result.parse(
        await request(bootstrap, 'claim', 'connections.claim', { name: 'Test phone' }),
      )
      bootstrap.close()

      const device = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
      )
      await expect(request(device, 'projects', 'projects.list', {})).resolves.toEqual({
        projects: [],
      })
      const directory = methods['projects.browse'].result.parse(
        await request(device, 'browse', 'projects.browse', {}),
      )
      expect(directory.path).toBe(canonicalProjectBrowserHome)
      expect(directory.entries).toMatchObject([{ name: 'Developer', kind: 'directory' }])

      const addedProject = methods['projects.add'].result.parse(
        await request(device, 'add-project', 'projects.add', {
          path: canonicalBrowsableProject,
        }),
      )
      expect(addedProject.path).toBe(canonicalBrowsableProject)
      await expect(request(device, 'admin', 'connections.status', {})).rejects.toThrow(
        '[forbidden]',
      )

      const attachment = methods['attachments.saveFile'].result.parse(
        await request(device, 'attachment', 'attachments.saveFile', {
          name: 'reference.txt',
          mimeType: 'text/plain',
          data: Buffer.from('from phone').toString('base64'),
        }),
      )
      attachmentPath = attachment.path
      expect(readFileSync(attachment.path, 'utf8')).toBe('from phone')

      const closed = once(device, 'close')
      await request(admin, 'revoke', 'connections.revoke', { deviceId: claimed.deviceId })
      const [code] = (await closed) as [number, Buffer]
      expect(code).toBe(1006)
    } finally {
      for (const socket of sockets) socket.terminate()
      await server.close()
      if (attachmentPath) rmSync(attachmentPath, { force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('restores mobile access and the saved device credential after a server restart', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'harness-mobile-restart-'))
    process.env['HARNESS_DATA_DIR'] = dataDir
    const port = await availablePort()
    const firstServer = startServer({
      port,
      accessToken: 'desktop-admin',
      mobilePort: 0,
      mobileNetworkInterfaces: () => INTERFACES,
      resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
      webToken: WEB_TOKEN,
      webRoot: await fixtureWebApp(),
      webDevServerProbeUrl: false,
    })
    const sockets = new Set<WebSocket>()
    let firstServerClosed = false
    let secondServer: ReturnType<typeof startServer> | undefined

    try {
      const admin = await openSocket(
        sockets,
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent('desktop-admin')}`,
      )
      const offer = methods['connections.startPairing'].result.parse(
        await request(admin, 'pair', 'connections.startPairing', {}),
      )
      const bootstrap = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?pairing_ticket=${encodeURIComponent(pairingTicket(offer.pairingUri))}`,
      )
      const claimed = methods['connections.claim'].result.parse(
        await request(bootstrap, 'claim', 'connections.claim', { name: 'Persistent phone' }),
      )
      bootstrap.close()

      const connected = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
      )
      const disconnected = once(connected, 'close')
      await firstServer.close()
      firstServerClosed = true
      await disconnected

      secondServer = startServer({
        port,
        accessToken: 'desktop-admin',
        mobilePort: offer.port,
        mobileNetworkInterfaces: () => INTERFACES,
        resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
        webToken: WEB_TOKEN,
        webRoot: await fixtureWebApp(),
        webDevServerProbeUrl: false,
      })
      await waitForPort(offer.port)
      const restored = await openSocket(
        sockets,
        `ws://127.0.0.1:${offer.port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
      )

      await expect(request(restored, 'projects', 'projects.list', {})).resolves.toEqual({
        projects: [],
      })

      // The bookmarked web-app URL is byte-identical after the restart.
      const admin2 = await openSocket(
        sockets,
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent('desktop-admin')}`,
      )
      const statusAfterRestart = methods['connections.status'].result.parse(
        await request(admin2, 'status-after-restart', 'connections.status', {}),
      )
      expect(statusAfterRestart.webUrls).toEqual([
        `http://100.101.22.33:${offer.port}/#access_token=${WEB_TOKEN}`,
      ])
      expect(statusAfterRestart.devices.map((device) => device.name)).toEqual(['Persistent phone'])
    } finally {
      for (const socket of sockets) socket.terminate()
      if (secondServer) await secondServer.close()
      if (!firstServerClosed) await firstServer.close()
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

async function waitForPort(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (open) return
    await delay(25)
  }
  throw new Error(`mobile listener on port ${port} did not restart`)
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
      if ('error' in parsed) reject(new Error(`[${parsed.error.code}] ${parsed.error.message}`))
      else resolve(parsed.result)
    }
    socket.on('message', onMessage)
  })
  socket.send(JSON.stringify({ id, method, params }))
  return response
}

function pairingTicket(uri: string): string {
  const encoded = new URL(uri).searchParams.get('payload')
  if (!encoded) throw new Error('missing pairing payload')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket: string }
  return payload.ticket
}

async function fixtureWebApp(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-web-app-'))
  mkdirSync(path.join(dir, 'assets'), { recursive: true })
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head></head><body>fixture-app-marker</body></html>',
  )
  return dir
}

function asText(raw: unknown): string {
  return Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw as ArrayBufferLike).toString()
}
