import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIPv4, type AddressInfo } from 'node:net'
import os, { type NetworkInterfaceInfo } from 'node:os'
import path from 'node:path'
import { runCli } from '@harness/proc'
import { WebSocketServer, type WebSocket, type WebSocketServer as WebSocketServerType } from 'ws'
import type { ConnectionAddress, ConnectionsStatus } from '@harness/contracts'
import type { Store } from './store.js'

const PAIRING_TTL_MS = 5 * 60 * 1_000

export type MobileConnectionAccess =
  { kind: 'pairing'; ticketHash: string } | { kind: 'device'; deviceId: string }

type ConnectionHandler = (
  socket: WebSocket,
  request: IncomingMessage,
  access: MobileConnectionAccess,
) => void

export class MobileAccess {
  #store: Store
  #configuredPort: number
  #serverName: string
  #interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  #resolveTailscaleAddresses: () => Promise<ReadonlySet<string>>
  #tailscaleAddresses = new Set<string>()
  #tailscaleAddressesLoaded = false
  #onConnection: ConnectionHandler
  #server: WebSocketServerType | undefined
  #starting: Promise<void> | undefined
  #listeningPort: number | undefined
  #tickets = new Map<string, number>()

  constructor(options: {
    store: Store
    port: number
    onConnection: ConnectionHandler
    serverName?: string
    networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
    resolveTailscaleAddresses?: () => Promise<ReadonlySet<string>>
  }) {
    this.#store = options.store
    this.#configuredPort = options.port
    this.#onConnection = options.onConnection
    this.#serverName = options.serverName ?? os.hostname()
    this.#interfaces = options.networkInterfaces ?? os.networkInterfaces
    this.#resolveTailscaleAddresses = options.resolveTailscaleAddresses ?? detectTailscaleAddresses
  }

  status(): ConnectionsStatus {
    const port = this.#listeningPort ?? this.#configuredPort
    const enabled = this.#listeningPort !== undefined
    return {
      enabled,
      serverName: this.#serverName,
      port,
      addresses: enabled
        ? connectionAddresses(this.#interfaces(), port, this.#tailscaleAddresses)
        : [],
      devices: this.#store.pairedDevices(),
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
    this.#server = undefined
    this.#listeningPort = undefined
    this.#tickets.clear()
    if (!server) return
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  async startPairing(): Promise<ConnectionsStatus & { pairingUri: string; expiresAt: number }> {
    this.#tailscaleAddressesLoaded = false
    await this.#loadTailscaleAddresses()
    await this.start()
    const status = this.status()
    if (status.addresses.length === 0) {
      await this.stop()
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
    return {
      ...status,
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
    for (const socket of this.#server?.clients ?? []) {
      const access = socketAccess.get(socket)
      if (access?.kind === 'device' && access.deviceId === deviceId) socket.terminate()
    }
  }

  isDeviceActive(deviceId: string): boolean {
    return this.#store.hasPairedDevice(deviceId)
  }

  async #startServer(): Promise<void> {
    await this.#loadTailscaleAddresses()
    const server = new WebSocketServer({ host: '0.0.0.0', port: this.#configuredPort })
    this.#server = server
    server.on('connection', (socket, request) => {
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
      socketAccess.set(socket, access)
      socket.once('close', () => socketAccess.delete(socket))
      this.#onConnection(socket, request, access)
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.once('listening', () => {
          server.off('error', onError)
          resolve()
        })
      })
      const address = server.address() as AddressInfo | string | null
      this.#listeningPort =
        typeof address === 'object' && address ? address.port : this.#configuredPort
      server.on('error', (error) => console.error(`[server] mobile access: ${error.message}`))
      console.log(`[server] mobile access listening on ws://0.0.0.0:${this.#listeningPort}`)
    } catch (error) {
      this.#server = undefined
      this.#listeningPort = undefined
      server.close()
      throw error
    }
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

function cleanDeviceName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Mobile device'
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
