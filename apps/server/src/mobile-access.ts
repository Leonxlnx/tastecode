import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { isIPv4, type AddressInfo } from 'node:net'
import os, { type NetworkInterfaceInfo } from 'node:os'
import path from 'node:path'
import { runCli } from '@harness/proc'
import { WebSocketServer, type WebSocket, type WebSocketServer as WebSocketServerType } from 'ws'
import type { ConnectionAddress, ConnectionsStatus } from '@harness/contracts'
import type { Store } from './store.js'

const PAIRING_TTL_MS = 5 * 60 * 1_000
/** The Vite dev server the desktop stack runs on loopback. */
const DEFAULT_WEB_DEV_SERVER_URL = 'http://127.0.0.1:5183'

export type MobileConnectionAccess =
  { kind: 'pairing'; ticketHash: string } | { kind: 'device'; deviceId: string } | { kind: 'admin' }

/**
 * Whether the Vite dev server answers on `targetUrl` (dev convenience). The
 * mobile web surface prefers the live source when a dev stack is running, and
 * falls back to the built client when it is not — the explicit
 * `webDevServerUrl` option overrides this probe.
 */
export async function probeDevServer(targetUrl: string): Promise<string | undefined> {
  const target = new URL(targetUrl)
  return new Promise((resolve) => {
    const probe = httpRequest(target, { method: 'HEAD' }, (response) => {
      response.resume()
      resolve(response.statusCode === 200 ? target.toString() : undefined)
    })
    probe.setTimeout(500, () => probe.destroy())
    probe.on('timeout', () => resolve(undefined))
    probe.on('error', () => resolve(undefined))
    probe.end()
  })
}

type ConnectionHandler = (
  socket: WebSocket,
  request: IncomingMessage,
  access: MobileConnectionAccess,
) => void

/**
 * The mobile listener: one port, two surfaces.
 *
 * - **Web app** — the full harness UI, served over HTTP at `/`. The phone
 *   loads it from `http://<address>:<port>/#access_token=…` and the page
 *   derives its WebSocket from its own origin, so nothing needs to be baked
 *   per machine. The long-lived web token (OS credential store) keeps the
 *   URL stable across restarts, and grants full admin access — this is the
 *   desktop app on a phone.
 * - **Native-app protocol** — the existing WebSocket surface at `/` (and
 *   `/ws` for browser clients) that paired native apps and the pairing
 *   bootstrap speak. Its scheme is unchanged.
 *
 * The listener binds whenever the server runs, so both stay reachable
 * even when native-app connections are switched off ("mobile access" off
 * means the device tokens stop being accepted, not that the web surfaces
 * disappear). Device management itself lives in the desktop app's Settings,
 * never in a separate web page.
 */
export class MobileAccess {
  #store: Store
  #configuredPort: number
  #serverName: string
  #interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  #resolveTailscaleAddresses: () => Promise<ReadonlySet<string>>
  #tailscaleAddresses = new Set<string>()
  #tailscaleAddressesLoaded = false
  #onConnection: ConnectionHandler
  #server: ReturnType<typeof createServer> | undefined
  #wss: WebSocketServerType | undefined
  #starting: Promise<void> | undefined
  #listeningPort: number | undefined
  #tickets = new Map<string, number>()
  #protocolEnabled = false
  #webToken: string
  #webRoot: string | undefined
  #webDevServerUrl: string | undefined
  #webDevServerProbeUrl: string | false

  constructor(options: {
    store: Store
    port: number
    onConnection: ConnectionHandler
    serverName?: string
    networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
    resolveTailscaleAddresses?: () => Promise<ReadonlySet<string>>
    /** Long-lived token that authenticates the full web app on a phone.
     * Empty disables the web-app surface. */
    webToken?: string
    /** Directory containing the built web app (`index.html` at its root).
     * When absent, `/` serves nothing and the phone web app is disabled. */
    webRoot?: string | undefined
    /** Vite dev server to proxy the web-app surface to (dev only). When set,
     * the phone loads the live source through this listener instead of the
     * built `webRoot`, so edits show up without a rebuild. */
    webDevServerUrl?: string | undefined
    /** Where to probe for a live Vite dev server when `webDevServerUrl` is
     * absent. `false` disables the probe (tests, explicit deployments). */
    webDevServerProbeUrl?: string | false
  }) {
    this.#store = options.store
    this.#configuredPort = options.port
    this.#onConnection = options.onConnection
    this.#serverName = options.serverName ?? os.hostname()
    this.#interfaces = options.networkInterfaces ?? os.networkInterfaces
    this.#resolveTailscaleAddresses = options.resolveTailscaleAddresses ?? detectTailscaleAddresses
    this.#webToken = options.webToken ?? ''
    this.#webRoot = options.webRoot ? path.resolve(options.webRoot) : undefined
    this.#webDevServerUrl = options.webDevServerUrl
    this.#webDevServerProbeUrl = options.webDevServerProbeUrl ?? DEFAULT_WEB_DEV_SERVER_URL
  }

  status(): ConnectionsStatus {
    const port = this.#listeningPort ?? this.#configuredPort
    const listening = this.#listeningPort !== undefined
    const addresses = listening
      ? connectionAddresses(this.#interfaces(), port, this.#tailscaleAddresses)
      : []
    return {
      enabled: listening && this.#protocolEnabled,
      serverName: this.#serverName,
      port,
      addresses,
      devices: this.#store.pairedDevices(),
      webUrls:
        listening && this.#webToken && (this.#webRoot || this.#webDevServerUrl)
          ? addresses.map((address) => webUrlFor(address.url, this.#webToken))
          : [],
    }
  }

  async start(): Promise<void> {
    if (this.#listeningPort !== undefined) return
    if (this.#starting) return this.#starting
    this.#starting = this.#startServer()
    try {
      await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async stop(): Promise<void> {
    if (this.#starting) await this.#starting.catch(() => undefined)
    const server = this.#server
    const wss = this.#wss
    this.#server = undefined
    this.#wss = undefined
    this.#listeningPort = undefined
    this.#tickets.clear()
    if (!server) return
    for (const socket of wss?.clients ?? []) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * Whether the native-app protocol (device tokens, new pairings) is
   * accepted. The web-app surface is unaffected. Persisted via the store so
   * it survives restarts.
   */
  setProtocolEnabled(enabled: boolean): void {
    this.#protocolEnabled = enabled
    if (enabled) return
    this.#tickets.clear()
    for (const socket of this.#wss?.clients ?? []) {
      const access = socketAccess.get(socket)
      if (access?.kind === 'device') socket.terminate()
    }
  }

  async startPairing(): Promise<ConnectionsStatus & { pairingUri: string; expiresAt: number }> {
    this.#tailscaleAddressesLoaded = false
    await this.#loadTailscaleAddresses()
    await this.start()
    const status = this.status()
    if (status.addresses.length === 0) {
      await this.stop()
      this.setProtocolEnabled(false)
      this.#store.setMobileAccessEnabled(false)
      throw new Error('No Tailscale or private LAN address is available on this computer')
    }

    this.#tickets.clear()
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.#tickets.set(digest(ticket), expiresAt)
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        serverName: status.serverName,
        ticket,
        expiresAt,
        endpoints: status.addresses.map((address) => address.url),
      }),
    ).toString('base64url')
    this.setProtocolEnabled(true)
    this.#store.setMobileAccessEnabled(true)
    return {
      ...this.status(),
      pairingUri: `harness://pair?payload=${encodeURIComponent(payload)}`,
      expiresAt,
    }
  }

  authorize(requestUrl: string | undefined): MobileConnectionAccess | undefined {
    this.#pruneTickets()
    const url = new URL(requestUrl ?? '/', 'ws://harness.local')
    const pairingTicket = url.searchParams.get('pairing_ticket')
    if (pairingTicket) {
      const ticketHash = digest(pairingTicket)
      if (this.#tickets.has(ticketHash)) return { kind: 'pairing', ticketHash }
    }

    const deviceToken = url.searchParams.get('token')
    if (!deviceToken) return undefined
    // The web app (served from this listener) authenticates with the long-lived
    // web token and is a full admin client, exactly like the desktop renderer.
    if (this.#webToken && safeEqual(deviceToken, this.#webToken)) {
      return { kind: 'admin' }
    }
    const device = this.#store.pairedDeviceForTokenHash(digest(deviceToken))
    if (!device) return undefined
    this.#store.touchPairedDevice(device.id)
    return { kind: 'device', deviceId: device.id }
  }

  claim(access: MobileConnectionAccess, name: string) {
    if (access.kind !== 'pairing') throw new Error('A current pairing ticket is required')
    const expiresAt = this.#tickets.get(access.ticketHash)
    if (!expiresAt || expiresAt <= Date.now()) {
      this.#tickets.delete(access.ticketHash)
      throw new Error('This pairing code has expired')
    }

    const deviceToken = randomBytes(32).toString('base64url')
    const device = this.#store.pairDevice(cleanDeviceName(name), digest(deviceToken))
    this.#tickets.delete(access.ticketHash)
    return {
      deviceId: device.id,
      deviceToken,
      serverName: this.#serverName,
      addresses: this.status().addresses,
    }
  }

  revoke(deviceId: string): void {
    this.#store.revokePairedDevice(deviceId)
    for (const socket of this.#wss?.clients ?? []) {
      const access = socketAccess.get(socket)
      if (access?.kind === 'device' && access.deviceId === deviceId) socket.terminate()
    }
  }

  isDeviceActive(deviceId: string): boolean {
    return this.#store.hasPairedDevice(deviceId)
  }

  async #startServer(): Promise<void> {
    await this.#loadTailscaleAddresses()
    if (!this.#webDevServerUrl && this.#webDevServerProbeUrl !== false) {
      const devServer = await probeDevServer(this.#webDevServerProbeUrl)
      if (devServer) {
        this.#webDevServerUrl = devServer
        console.log(`[server] mobile web app proxying to Vite dev server at ${devServer}`)
      }
    }
    const server = createServer((request, response) => this.#handleHttp(request, response))
    const wss = new WebSocketServer({ noServer: true })
    this.#server = server
    this.#wss = wss
    wss.on('connection', (socket, request) => {
      if (!listenerAddressAllowed(request.socket.localAddress, this.status().addresses)) {
        socket.close(1008, 'Interface not allowed')
        return
      }
      let access: MobileConnectionAccess | undefined
      try {
        access = this.authorize(request.url)
      } catch {
        socket.close(1008, 'Access denied')
        return
      }
      if (!access) {
        socket.close(1008, 'Access denied')
        return
      }
      if (access.kind === 'device' && !this.#protocolEnabled) {
        socket.close(1008, 'Mobile access is off')
        return
      }
      socketAccess.set(socket, access)
      socket.once('close', () => socketAccess.delete(socket))
      this.#onConnection(socket, request, access)
    })

    server.on('upgrade', (request, socket, head) => {
      let pathname: string
      try {
        pathname = new URL(request.url ?? '/', 'http://harness.local').pathname
      } catch {
        socket.destroy()
        return
      }
      // `/` keeps the native app's existing URL scheme (`ws://ip:port/?token=…`);
      // `/ws` is what the browser web app uses.
      if (pathname !== '/' && pathname !== '/ws') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (websocket) =>
        wss.emit('connection', websocket, request),
      )
    })
    server.on('clientError', (_error, socket) => socket.destroy())

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(this.#configuredPort, '0.0.0.0', () => {
          server.off('error', onError)
          resolve()
        })
      })
      const address = server.address() as AddressInfo | string | null
      this.#listeningPort =
        typeof address === 'object' && address ? address.port : this.#configuredPort
      server.on('error', (error) => console.error(`[server] mobile access: ${error.message}`))
      console.log(`[server] mobile access listening on http://0.0.0.0:${this.#listeningPort}`)
    } catch (error) {
      this.#server = undefined
      this.#wss = undefined
      this.#listeningPort = undefined
      server.close()
      throw error
    }
  }

  #handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://harness.local')
    const pathname = url.pathname

    if (!this.#webRoot && !this.#webDevServerUrl) {
      this.#respondHtml(response, 404, '<!doctype html><html><body>Not found</body></html>')
      return
    }

    // Everything else serves the built web app. The page is static and
    // carries no data, so it needs no token gate — the WebSocket it opens is
    // where the token matters (and it never leaves the client-side hash).
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Method not allowed')
      return
    }
    if (this.#webDevServerUrl) {
      this.#proxyWebApp(request, response, url)
      return
    }
    this.#serveWebApp(pathname, response)
  }

  /**
   * Dev only: forwards the phone's page and asset requests to the Vite dev
   * server (loopback), so the mobile surface serves the same live source the
   * desktop window loads. The page's WebSocket is derived from its own origin
   * and still lands on this listener, so the token gate is untouched.
   */
  #proxyWebApp(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const devServer = this.#webDevServerUrl
    if (!devServer) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const target = new URL(devServer)
    target.pathname = url.pathname
    target.search = url.search
    const proxy = httpRequest(
      target,
      {
        method: request.method,
        headers: {
          ...request.headers,
          host: target.host,
          // Serve uncompressed through the listener; the phone's browser
          // negotiates with Vite directly where it matters.
          'accept-encoding': 'identity',
        },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers)
        upstream.pipe(response)
      },
    )
    proxy.on('error', () => {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Dev server unavailable')
    })
    request.on('error', () => proxy.destroy())
    request.pipe(proxy)
  }

  #respondHtml(response: ServerResponse, status: number, html: string): void {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    response.end(html)
  }

  /**
   * Serves the built web app from `#webRoot`. `url.pathname` keeps `..` and
   * percent-encoding literal, so a resolved path can only escape the root via
   * a real `..` segment — which the prefix check below rejects.
   */
  #serveWebApp(pathname: string, response: ServerResponse): void {
    const webRoot = this.#webRoot
    if (!webRoot) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    if (pathname.includes('\0')) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Bad request')
      return
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const resolved = path.resolve(webRoot, relative)
    const withinRoot = resolved === webRoot || resolved.startsWith(webRoot + path.sep)
    if (!withinRoot) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Forbidden')
      return
    }

    let file = resolved
    if (existsSync(file) && statSync(file).isDirectory()) {
      file = path.join(file, 'index.html')
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      // SPA fallback: unknown routes render the app shell.
      file = path.join(webRoot, 'index.html')
    }

    let body: Buffer
    try {
      body = readFileSync(file)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const isHtml = file.endsWith('.html')
    response.writeHead(200, {
      'Content-Type': contentTypeFor(file),
      'Cache-Control': isHtml ? 'no-store' : 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  #pruneTickets(): void {
    const now = Date.now()
    for (const [hash, expiresAt] of this.#tickets) {
      if (expiresAt <= now) this.#tickets.delete(hash)
    }
  }

  async #loadTailscaleAddresses(): Promise<void> {
    if (this.#tailscaleAddressesLoaded) return
    this.#tailscaleAddressesLoaded = true
    try {
      this.#tailscaleAddresses = new Set(await this.#resolveTailscaleAddresses())
    } catch {
      this.#tailscaleAddresses = new Set()
    }
  }
}

const socketAccess = new WeakMap<WebSocket, MobileConnectionAccess>()

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function cleanDeviceName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Mobile device'
}

/** The bookmarkable URL that opens the full web app on a phone. */
export function webUrlFor(wsUrl: string, token: string): string {
  const base = wsUrl.replace(/^wss?/i, 'http')
  return `${base}/#access_token=${encodeURIComponent(token)}`
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function connectionAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  port: number,
  tailscaleAddresses: ReadonlySet<string> = new Set(),
): ConnectionAddress[] {
  const addresses: ConnectionAddress[] = []
  const seen = new Set<string>()
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || seen.has(entry.address)) continue
      const kind = addressKind(entry.address, tailscaleAddresses)
      if (!kind) continue
      seen.add(entry.address)
      addresses.push({
        kind,
        label:
          kind === 'tailscale' ? `Tailscale ${entry.address}` : `${interfaceName} ${entry.address}`,
        url: `ws://${entry.address}:${port}`,
      })
    }
  }
  return addresses.sort((left, right) => {
    if (left.kind === right.kind) return left.label.localeCompare(right.label)
    return left.kind === 'tailscale' ? -1 : 1
  })
}

function addressKind(
  address: string,
  tailscaleAddresses: ReadonlySet<string>,
): ConnectionAddress['kind'] | undefined {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4) return undefined
  const [first, second] = octets
  if (first === 100 && second !== undefined && second >= 64 && second <= 127) {
    return tailscaleAddresses.has(address) ? 'tailscale' : undefined
  }
  if (first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31)) {
    return 'lan'
  }
  return first === 192 && second === 168 ? 'lan' : undefined
}

export function listenerAddressAllowed(
  localAddress: string | undefined,
  advertisedAddresses: ConnectionAddress[],
): boolean {
  if (!localAddress) return false
  const normalized = localAddress.replace(/^::ffff:/, '')
  if (normalized === '::1' || (isIPv4(normalized) && normalized.startsWith('127.'))) return true
  return advertisedAddresses.some((address) => new URL(address.url).hostname === normalized)
}

async function detectTailscaleAddresses(): Promise<ReadonlySet<string>> {
  const candidates = ['tailscale']
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  }
  if (process.platform === 'win32' && process.env['ProgramFiles']) {
    candidates.push(path.join(process.env['ProgramFiles'], 'Tailscale', 'tailscale.exe'))
  }
  for (const command of candidates) {
    try {
      const result = await runCli(command, ['ip', '-4'], 3_000)
      if (result.code !== 0) continue
      const addresses = result.stdout.trim().split(/\s+/).filter(isIPv4)
      if (addresses.length > 0) return new Set(addresses)
    } catch {
      // Try the next normal installation location.
    }
  }
  return new Set()
}
