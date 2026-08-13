import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  connectionAddresses,
  listenerAddressAllowed,
  MobileAccess,
  probeDevServer,
  type MobileConnectionAccess,
} from './mobile-access.js'
import { Store } from './store.js'

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
  en0: [
    {
      address: '192.168.1.44',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.44/24',
    },
    {
      address: '8.8.8.8',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:02',
      internal: false,
      cidr: '8.8.8.8/24',
    },
  ],
}

describe('mobile access', () => {
  it('offers verified Tailscale routes before LAN and excludes public interfaces', () => {
    const addresses = connectionAddresses(INTERFACES, 4312, new Set(['100.101.22.33']))
    expect(addresses).toEqual([
      {
        kind: 'tailscale',
        label: 'Tailscale 100.101.22.33',
        url: 'ws://100.101.22.33:4312',
      },
      { kind: 'lan', label: 'en0 192.168.1.44', url: 'ws://192.168.1.44:4312' },
    ])
    expect(listenerAddressAllowed('::ffff:192.168.1.44', addresses)).toBe(true)
    expect(listenerAddressAllowed('8.8.8.8', addresses)).toBe(false)
  })

  it('invalidates a pairing ticket when a replacement is generated', async () => {
    const store = new Store(':memory:')
    const access = createAccess(store)
    try {
      const first = pairingTicket((await access.startPairing()).pairingUri)
      const second = pairingTicket((await access.startPairing()).pairingUri)
      expect(access.authorize(`/?pairing_ticket=${first}`)).toBeUndefined()
      expect(access.authorize(`/?pairing_ticket=${second}`)?.kind).toBe('pairing')
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('exchanges one ticket for a revocable device token', async () => {
    const store = new Store(':memory:')
    const access = createAccess(store)
    try {
      const ticket = pairingTicket((await access.startPairing()).pairingUri)
      const bootstrap = access.authorize(`/?pairing_ticket=${ticket}`)
      if (!bootstrap) throw new Error('missing pairing access')

      const failedInsert = vi.spyOn(store, 'pairDevice').mockImplementationOnce(() => {
        throw new Error('database unavailable')
      })
      expect(() => access.claim(bootstrap, 'Test phone')).toThrow('database unavailable')
      failedInsert.mockRestore()
      expect(access.authorize(`/?pairing_ticket=${ticket}`)).toEqual(bootstrap)

      const claimed = access.claim(bootstrap, 'Test phone')
      expect(access.authorize(`/?pairing_ticket=${ticket}`)).toBeUndefined()
      expect(access.authorize(`/?token=${claimed.deviceToken}`)).toEqual({
        kind: 'device',
        deviceId: claimed.deviceId,
      })
      access.revoke(claimed.deviceId)
      expect(access.authorize(`/?token=${claimed.deviceToken}`)).toBeUndefined()
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('disables persisted access when no private route can be advertised', async () => {
    const store = new Store(':memory:')
    store.setMobileAccessEnabled(true)
    const access = new MobileAccess({
      store,
      port: 0,
      networkInterfaces: () => ({}),
      resolveTailscaleAddresses: async () => new Set(),
      onConnection: () => undefined,
    })
    try {
      await expect(access.startPairing()).rejects.toThrow('No Tailscale or private LAN address')
      expect(store.mobileAccessEnabled()).toBe(false)
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('serves the full web app at the root without a token gate', async () => {
    const store = new Store(':memory:')
    const webRoot = await fixtureWebApp()
    const access = createAccess(store, {
      webToken: 'stable-web-token',
      webRoot,
    })
    await access.start()
    const port = access.status().port
    const base = `http://127.0.0.1:${port}`
    try {
      const page = await fetch(`${base}/`)
      expect(page.status).toBe(200)
      expect(page.headers.get('cache-control')).toBe('no-store')
      expect(await page.text()).toContain('fixture-app-marker')

      const asset = await fetch(`${base}/assets/app.js`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('text/javascript')
      expect(await asset.text()).toContain('fixture-bundle')

      const head = await fetch(`${base}/`, { method: 'HEAD' })
      expect(head.status).toBe(200)

      // Unknown routes fall back to the app shell.
      const deep = await fetch(`${base}/some/client/route`)
      expect(deep.status).toBe(200)
      expect(await deep.text()).toContain('fixture-app-marker')

      // Percent-encoded traversal stays inside the root: the request resolves
      // to a literal name that does not exist, so the shell is served instead
      // of anything outside the build directory.
      const escaped = await fetch(`${base}/%2e%2e%2fharness-secret.txt`)
      expect(escaped.status).toBe(200)
      expect(await escaped.text()).not.toContain('TOP-SECRET')

      expect(access.status().webUrls).toEqual([
        `http://100.101.22.33:${port}/#access_token=stable-web-token`,
        `http://192.168.1.44:${port}/#access_token=stable-web-token`,
      ])
    } finally {
      await access.stop()
      store.close()
      rmSync(webRoot, { recursive: true, force: true })
    }
  })

  it('proxies the web-app surface to the Vite dev server in dev', async () => {
    const store = new Store(':memory:')
    const devServer = createServer((request, response) => {
      if (request.url?.startsWith('/assets/')) {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
        response.end('// live-dev-bundle\n')
        return
      }
      // Vite serves the app shell for unknown routes too; the proxy must not
      // impose its own SPA fallback in front of a live dev server.
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      response.end('<!doctype html><html><body>live-dev-marker</body></html>')
    })
    await new Promise<void>((resolve, reject) => {
      devServer.once('error', reject)
      devServer.listen(0, '127.0.0.1', resolve)
    })
    const devAddress = devServer.address()
    if (!devAddress || typeof devAddress === 'string') throw new Error('could not start dev server')

    const access = createAccess(store, {
      webToken: 'stable-web-token',
      webDevServerUrl: `http://127.0.0.1:${devAddress.port}`,
    })
    await access.start()
    const port = access.status().port
    const base = `http://127.0.0.1:${port}`
    try {
      const page = await fetch(`${base}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('live-dev-marker')

      const asset = await fetch(`${base}/assets/app.js`)
      expect(asset.status).toBe(200)
      expect(await asset.text()).toContain('live-dev-bundle')

      const deep = await fetch(`${base}/some/client/route`)
      expect(deep.status).toBe(200)
      expect(await deep.text()).toContain('live-dev-marker')

      const head = await fetch(`${base}/`, { method: 'HEAD' })
      expect(head.status).toBe(200)

      // The stable phone URL is still reported with no dist present.
      expect(access.status().webUrls).toEqual([
        `http://100.101.22.33:${port}/#access_token=stable-web-token`,
        `http://192.168.1.44:${port}/#access_token=stable-web-token`,
      ])
    } finally {
      await access.stop()
      store.close()
      await new Promise<void>((resolve) => devServer.close(() => resolve()))
    }
  })

  it('auto-detects the Vite dev server at a reachable loopback URL', async () => {
    const devServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body>vite</body></html>')
    })
    await new Promise<void>((resolve, reject) => {
      devServer.once('error', reject)
      devServer.listen(0, '127.0.0.1', resolve)
    })
    const devAddress = devServer.address()
    if (!devAddress || typeof devAddress === 'string') throw new Error('could not start dev server')
    const target = `http://127.0.0.1:${devAddress.port}`
    try {
      await expect(probeDevServer(target)).resolves.toBe(new URL(target).toString())
    } finally {
      await new Promise<void>((resolve) => devServer.close(() => resolve()))
    }
  })

  it('does not auto-detect a dev server that is not listening', async () => {
    const port = await availablePort()
    await expect(probeDevServer(`http://127.0.0.1:${port}`)).resolves.toBeUndefined()
  })

  it('auto-detects a running dev server and proxies the web surface to it', async () => {
    const store = new Store(':memory:')
    const devServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><body>auto-detect-marker</body></html>')
    })
    await new Promise<void>((resolve, reject) => {
      devServer.once('error', reject)
      devServer.listen(0, '127.0.0.1', resolve)
    })
    const devAddress = devServer.address()
    if (!devAddress || typeof devAddress === 'string') throw new Error('could not start dev server')

    const access = createAccess(store, {
      webToken: 'stable-web-token',
      webDevServerProbeUrl: `http://127.0.0.1:${devAddress.port}`,
    })
    await access.start()
    const port = access.status().port
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('auto-detect-marker')
      expect(access.status().webUrls).toEqual([
        `http://100.101.22.33:${port}/#access_token=stable-web-token`,
        `http://192.168.1.44:${port}/#access_token=stable-web-token`,
      ])
    } finally {
      await access.stop()
      store.close()
      await new Promise<void>((resolve) => devServer.close(() => resolve()))
    }
  })

  it('admits the web app socket as an admin client', async () => {
    const store = new Store(':memory:')
    const connections: MobileConnectionAccess[] = []
    const access = createAccess(store, {
      webToken: 'stable-web-token',
      onConnection: (_socket, _request, connection) => connections.push(connection),
    })
    await access.start()
    const port = access.status().port
    try {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent('stable-web-token')}`,
      )
      await once(socket, 'open')
      expect(connections.some((connection) => connection.kind === 'admin')).toBe(true)
      socket.close()
      await once(socket, 'close')

      // A device token that happens to equal nothing still fails; only the
      // exact web token grants admin.
      const refused = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong-token`)
      const [refusedCode] = (await once(refused, 'close')) as [number, Buffer]
      expect(refusedCode).toBe(1008)
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('keeps the web-app socket reachable while devices are refused when access is off', async () => {
    const store = new Store(':memory:')
    const connections: MobileConnectionAccess[] = []
    const access = createAccess(store, {
      webToken: 'stable-web-token',
      onConnection: (_socket, _request, connection) => connections.push(connection),
    })
    await access.start()
    const port = access.status().port
    try {
      const offer = await access.startPairing()
      expect(offer.enabled).toBe(true)
      const claimed = access.claim(
        access.authorize(`/?pairing_ticket=${pairingTicket(offer.pairingUri)}`)!,
        'Phone',
      )

      // While enabled, a device token is accepted.
      const device = new WebSocket(
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
      )
      await once(device, 'open')
      device.close()
      await once(device, 'close')

      access.setProtocolEnabled(false)
      expect(access.status().enabled).toBe(false)

      // After stopping, the same device token is refused with 1008.
      const refused = new WebSocket(
        `ws://127.0.0.1:${port}/?token=${encodeURIComponent(claimed.deviceToken)}`,
      )
      const [refusedCode] = (await once(refused, 'close')) as [number, Buffer]
      expect(refusedCode).toBe(1008)

      // The web-app (admin) socket is unaffected.
      const adminSocket = new WebSocket(
        `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent('stable-web-token')}`,
      )
      await once(adminSocket, 'open')
      expect(connections.some((connection) => connection.kind === 'admin')).toBe(true)
      adminSocket.close()
      await once(adminSocket, 'close')
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('keeps the web-app URL byte-identical across restarts', async () => {
    const store = new Store(':memory:')
    const webRoot = await fixtureWebApp()
    const port = await availablePort()
    const first = createAccess(store, {
      webToken: 'stable-web-token',
      webRoot,
      port,
    })
    await first.start()
    const firstUrls = first.status().webUrls
    await first.stop()

    const second = createAccess(store, {
      webToken: 'stable-web-token',
      webRoot,
      port,
    })
    await second.start()
    try {
      expect(second.status().webUrls).toEqual(firstUrls)
      expect(second.status().port).toBe(port)
    } finally {
      await second.stop()
      store.close()
      rmSync(webRoot, { recursive: true, force: true })
    }
  })
})

function createAccess(
  store: Store,
  options: {
    webToken?: string
    webRoot?: string
    webDevServerUrl?: string
    webDevServerProbeUrl?: string | false
    port?: number
    onConnection?: (
      socket: WebSocket,
      request: IncomingMessage,
      access: MobileConnectionAccess,
    ) => void
  } = {},
): MobileAccess {
  return new MobileAccess({
    store,
    port: options.port ?? 0,
    serverName: 'Test computer',
    networkInterfaces: () => INTERFACES,
    resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
    webToken: options.webToken,
    webRoot: options.webRoot,
    webDevServerUrl: options.webDevServerUrl,
    webDevServerProbeUrl: options.webDevServerProbeUrl ?? false,
    onConnection: options.onConnection ?? (() => undefined),
  })
}

async function fixtureWebApp(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-web-app-'))
  mkdirSync(path.join(dir, 'assets'), { recursive: true })
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head></head><body>fixture-app-marker<script src="./assets/app.js"></script></body></html>',
  )
  writeFileSync(path.join(dir, 'assets', 'app.js'), '// fixture-bundle\n')
  // A file outside the build directory that must never leak.
  writeFileSync(path.join(dir, '..', 'harness-secret.txt'), 'TOP-SECRET')
  return dir
}

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

function pairingTicket(uri: string): string {
  const encoded = new URL(uri).searchParams.get('payload')
  if (!encoded) throw new Error('missing pairing payload')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket?: unknown }
  if (typeof payload.ticket !== 'string') throw new Error('missing pairing ticket')
  return payload.ticket
}
