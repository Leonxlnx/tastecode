import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { isIPv4, isIPv6 } from 'node:net'
import os, { type NetworkInterfaceInfo } from 'node:os'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { z } from 'zod'
import {
  PHONE_LINK_PATH,
  PHONE_LINK_VERSION,
  PHONE_PAIRING_SCHEME,
  type MethodName,
  type PhoneAccessStatus,
  type PhoneAddress,
  type PhoneDevice,
  type PhonePairing,
  type PhonePairingPayload,
} from '@harness/contracts'
import {
  generateNoiseKeyPair,
  noisePublicKey,
  NoiseResponder,
  type CipherState,
  type NoiseKeyPair,
} from './phone-noise.js'
import type { PushSocket } from './push-bus.js'

export const DEFAULT_PHONE_PORT = 4317
const PAIRING_TTL_MS = 10 * 60 * 1_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_HANDSHAKE_BYTES = 4_096
/** Large enough for a full chat history reply or a pasted photo. */
const MAX_LINK_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_PENDING_HANDSHAKES = 32
const FAILED_HANDSHAKES_PER_MINUTE = 30
const PING_INTERVAL_MS = 20_000

/**
 * Everything a paired phone may ask. Reading and driving chats, choosing a
 * model and access level, and adding projects; nothing that opens a shell,
 * installs software, changes credentials or pairs further devices.
 */
export const PHONE_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'system.info',
  'providers.list',
  'models.list',
  'connections.list',
  'connections.models',
  'acp.agents',
  'accounts.list',
  'auth.status',
  'commands.list',
  'search.sessions',
  'usage.summary',
  'projects.list',
  'projects.add',
  'projects.browse',
  'projects.pin',
  'workspace.info',
  'workspace.diff',
  'attachments.saveImage',
  'backgroundModel.generateTitle',
  'thread.history',
  'thread.start',
  'thread.sendTurn',
  'thread.interrupt',
  'thread.queue',
  'thread.deleteQueuedTurn',
  'thread.moveQueuedTurn',
  'thread.steerQueuedTurn',
  'thread.respondToApproval',
  'thread.respondToUserInput',
  'thread.setApproval',
  'thread.settings',
  'thread.setSettings',
  'thread.changeProvider',
  'thread.rename',
  'thread.pin',
  'thread.settle',
  'thread.unsettle',
  'thread.diff',
])

/** Pushes a phone never receives: its own pairing state and desktop-only previews. */
const PHONE_HIDDEN_PUSH = /^\{"channel":"(?:phone|preview)\./

const StoredDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  publicKey: z.string().min(1),
  pairedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().optional(),
})
type StoredDevice = z.infer<typeof StoredDeviceSchema>

const StoredStateSchema = z.object({
  enabled: z.boolean(),
  devices: z.array(StoredDeviceSchema),
})
type StoredState = z.infer<typeof StoredStateSchema>

const HelloSchema = z.object({
  v: z.literal(PHONE_LINK_VERSION),
  name: z.string().trim().min(1).max(200),
  /** The pairing secret, present only on the first link from a new phone. */
  pair: z.string().max(64).optional(),
})

type Answer =
  | { v: number; ok: true; deviceId: string; serverName: string }
  | { v: number; ok: false; error: 'not_paired' | 'pairing_expired' | 'disabled' | 'bad_hello' }

export type PhoneStateStore = {
  phoneAccessState(): string | undefined
  setPhoneAccessState(value: string): void
}

export type PhoneKeyStore = {
  read(): string | undefined
  write(value: string): void
}

/**
 * One paired phone's link, as the core server sees a client: frames in and
 * out are the plain protocol JSON, encrypted and authenticated on the wire.
 */
export class PhoneLinkSocket implements PushSocket {
  readonly OPEN = 1
  readonly deviceId: string
  #socket: WebSocket
  #send: CipherState
  #receive: CipherState
  #messageListeners = new Set<(text: string) => void>()
  #closeListeners = new Set<() => void>()
  #closed = false

  constructor(socket: WebSocket, deviceId: string, send: CipherState, receive: CipherState) {
    this.#socket = socket
    this.deviceId = deviceId
    this.#send = send
    this.#receive = receive
    socket.on('message', (data, isBinary) => this.#onMessage(data, isBinary))
    socket.on('close', () => this.#onClose())
    socket.on('error', () => this.terminate())
  }

  get readyState(): number {
    return this.#closed ? 3 : this.#socket.readyState
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount
  }

  send(frame: string, callback?: (error?: Error) => void): void {
    if (PHONE_HIDDEN_PUSH.test(frame)) {
      callback?.()
      return
    }
    try {
      this.#socket.send(this.#send.encrypt(Buffer.from(frame)), { binary: true }, callback)
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error('Phone link write failed'))
    }
  }

  terminate(): void {
    this.#socket.terminate()
    this.#onClose()
  }

  onMessage(listener: (text: string) => void): void {
    this.#messageListeners.add(listener)
  }

  onClose(listener: () => void): void {
    if (this.#closed) listener()
    else this.#closeListeners.add(listener)
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#closed) return
    if (!isBinary || !Buffer.isBuffer(data)) {
      this.terminate()
      return
    }
    let text: string
    try {
      text = this.#receive.decrypt(data).toString('utf8')
    } catch {
      // A frame that fails authentication means the stream can no longer be trusted.
      this.terminate()
      return
    }
    for (const listener of this.#messageListeners) listener(text)
  }

  #onClose(): void {
    if (this.#closed) return
    this.#closed = true
    for (const listener of this.#closeListeners) listener()
    this.#closeListeners.clear()
    this.#messageListeners.clear()
  }
}

/**
 * The phone listener and the phones paired with this computer.
 *
 * Off by default. When on, it listens on every interface but answers only
 * private, tailnet and loopback addresses, refuses anything a browser could
 * send (an `Origin` header), and speaks nothing but a Noise IK handshake until
 * the phone has proved it holds a paired key or a fresh pairing secret.
 */
export class PhoneAccess {
  #store: PhoneStateStore
  #keys: PhoneKeyStore
  #port: number
  #host: string
  #serverName: string
  #interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  #onConnection: (socket: PhoneLinkSocket) => void
  #onChanged: (status: PhoneAccessStatus) => void
  #state: StoredState
  #serverKey: NoiseKeyPair | undefined
  #server: Server | undefined
  #wss: WebSocketServer | undefined
  #listening = false
  #starting: Promise<void> | undefined
  #error: string | undefined
  #pairing: { secretHash: Buffer; secret: string; expiresAt: number } | undefined
  #pairingTimer: ReturnType<typeof setTimeout> | undefined
  #links = new Map<string, Set<PhoneLinkSocket>>()
  #pendingHandshakes = 0
  #failures = new Map<string, number[]>()
  #pingTimer: ReturnType<typeof setInterval> | undefined
  /** Whether each socket answered the last ping. */
  #alive = new WeakMap<WebSocket, boolean>()

  constructor(options: {
    store: PhoneStateStore
    keys: PhoneKeyStore
    onConnection: (socket: PhoneLinkSocket) => void
    onChanged: (status: PhoneAccessStatus) => void
    port?: number
    host?: string
    serverName?: string
    networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  }) {
    this.#store = options.store
    this.#keys = options.keys
    this.#onConnection = options.onConnection
    this.#onChanged = options.onChanged
    this.#port = options.port ?? DEFAULT_PHONE_PORT
    this.#host = options.host ?? '0.0.0.0'
    this.#serverName = options.serverName ?? computerName()
    this.#interfaces = options.networkInterfaces ?? os.networkInterfaces
    this.#state = readState(this.#store.phoneAccessState())
  }

  status(): PhoneAccessStatus {
    return {
      enabled: this.#state.enabled,
      listening: this.#listening,
      port: this.#port,
      serverName: this.#serverName,
      addresses: this.#listening ? phoneAddresses(this.#interfaces()) : [],
      devices: this.#state.devices.map((device) => this.#publicDevice(device)),
      ...(this.#pairing ? { pairingExpiresAt: this.#pairing.expiresAt } : {}),
      ...(this.#state.enabled && this.#error ? { error: this.#error } : {}),
    }
  }

  /** Starts the listener when the user left phone access on. */
  async resume(): Promise<void> {
    if (this.#state.enabled) await this.#start()
  }

  async setEnabled(enabled: boolean): Promise<PhoneAccessStatus> {
    if (this.#state.enabled !== enabled) {
      this.#state = { ...this.#state, enabled }
      this.#save()
    }
    if (enabled) await this.#start()
    else await this.#stop()
    this.#changed()
    return this.status()
  }

  async startPairing(): Promise<{ status: PhoneAccessStatus; pairing: PhonePairing }> {
    if (!this.#state.enabled) {
      this.#state = { ...this.#state, enabled: true }
      this.#save()
    }
    await this.#start()
    if (!this.#listening) throw new Error(this.#error ?? 'Phone access could not start')
    const addresses = phoneAddresses(this.#interfaces())
    if (addresses.length === 0) {
      throw new Error('This computer has no local network or Tailscale address a phone can reach')
    }
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.#pairing = { secret, secretHash: digest(secret), expiresAt }
    clearTimeout(this.#pairingTimer)
    this.#pairingTimer = setTimeout(() => this.#closePairing(), PAIRING_TTL_MS)
    this.#pairingTimer.unref()
    const payload: PhonePairingPayload = {
      v: PHONE_LINK_VERSION,
      name: this.#serverName,
      key: this.#key().publicKey.toString('base64url'),
      port: this.#port,
      hosts: addresses.map((address) => address.host).slice(0, 16),
      secret,
      expiresAt,
    }
    this.#changed()
    return { status: this.status(), pairing: { uri: pairingUri(payload), expiresAt } }
  }

  cancelPairing(): PhoneAccessStatus {
    this.#closePairing()
    return this.status()
  }

  removeDevice(deviceId: string): PhoneAccessStatus {
    const devices = this.#state.devices.filter((device) => device.id !== deviceId)
    if (devices.length !== this.#state.devices.length) {
      this.#state = { ...this.#state, devices }
      this.#save()
      for (const link of this.#links.get(deviceId) ?? []) link.terminate()
      this.#links.delete(deviceId)
      this.#changed()
    }
    return this.status()
  }

  async close(): Promise<void> {
    clearTimeout(this.#pairingTimer)
    await this.#stop()
  }

  #publicDevice(device: StoredDevice): PhoneDevice {
    return {
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
      connected: (this.#links.get(device.id)?.size ?? 0) > 0,
    }
  }

  #key(): NoiseKeyPair {
    if (this.#serverKey) return this.#serverKey
    const stored = this.#keys.read()
    const privateKey = stored ? Buffer.from(stored, 'base64url') : undefined
    if (privateKey?.length === 32) {
      this.#serverKey = { privateKey, publicKey: noisePublicKey(privateKey) }
    } else {
      const generated = generateNoiseKeyPair()
      this.#keys.write(generated.privateKey.toString('base64url'))
      this.#serverKey = generated
    }
    return this.#serverKey
  }

  #save(): void {
    this.#store.setPhoneAccessState(JSON.stringify(this.#state))
  }

  #changed(): void {
    this.#onChanged(this.status())
  }

  #closePairing(): void {
    clearTimeout(this.#pairingTimer)
    this.#pairingTimer = undefined
    if (!this.#pairing) return
    this.#pairing = undefined
    this.#changed()
  }

  async #start(): Promise<void> {
    if (this.#listening) return
    if (this.#starting) return this.#starting
    this.#starting = this.#listen().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #listen(): Promise<void> {
    // Read or create the key before accepting anyone, so a keychain failure is
    // reported here rather than as a handshake that never completes.
    try {
      this.#key()
    } catch {
      this.#error = 'The phone link key could not be read from the system keychain'
      return
    }
    const server = createServer((_request, response) => {
      response.writeHead(404).end()
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_MESSAGE_BYTES })
    server.on('upgrade', (request, socket, head) => {
      if (!this.#acceptsUpgrade(request, socket)) return
      wss.handleUpgrade(request, socket, head, (ws) => this.#handshake(ws, request))
    })
    const started = await new Promise<string | undefined>((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        resolve(
          error.code === 'EADDRINUSE'
            ? `Port ${this.#port} is already in use, so phones cannot connect`
            : `Phone access could not start: ${error.message}`,
        ),
      )
      server.listen(this.#port, this.#host, () => resolve(undefined))
    })
    if (started) {
      this.#error = started
      server.close()
      return
    }
    server.on('error', () => undefined)
    const address = server.address()
    if (address !== null && typeof address === 'object') this.#port = address.port
    this.#server = server
    this.#wss = wss
    this.#listening = true
    this.#error = undefined
    this.#pingTimer = setInterval(() => this.#ping(), PING_INTERVAL_MS)
    this.#pingTimer.unref()
  }

  async #stop(): Promise<void> {
    if (this.#starting) await this.#starting.catch(() => undefined)
    clearInterval(this.#pingTimer)
    this.#closePairing()
    const server = this.#server
    const wss = this.#wss
    this.#server = undefined
    this.#wss = undefined
    this.#listening = false
    for (const socket of wss?.clients ?? []) socket.terminate()
    for (const links of this.#links.values()) for (const link of links) link.terminate()
    this.#links.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  #ping(): void {
    for (const socket of this.#wss?.clients ?? []) {
      if (this.#alive.get(socket) === false) {
        socket.terminate()
        continue
      }
      this.#alive.set(socket, false)
      socket.ping()
    }
  }

  #acceptsUpgrade(request: IncomingMessage, socket: Duplex): boolean {
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Forbidden'}\r\n\r\n`)
      return false
    }
    const remote = request.socket.remoteAddress ?? ''
    const path = new URL(request.url ?? '/', 'ws://phone.local').pathname
    // A browser always sends Origin; the phone app never does. No page may
    // reach this listener, whatever it guesses about the protocol.
    if (path !== PHONE_LINK_PATH || request.headers.origin !== undefined) return refuse(403)
    if (!isReachableAddress(remote)) return refuse(403)
    if (this.#pendingHandshakes >= MAX_PENDING_HANDSHAKES || this.#throttled(remote)) {
      return refuse(429)
    }
    return true
  }

  #throttled(remote: string): boolean {
    const now = Date.now()
    const recent = (this.#failures.get(remote) ?? []).filter((at) => now - at < 60_000)
    if (recent.length) this.#failures.set(remote, recent)
    else this.#failures.delete(remote)
    return recent.length >= FAILED_HANDSHAKES_PER_MINUTE
  }

  #fail(remote: string): void {
    const failures = this.#failures.get(remote) ?? []
    failures.push(Date.now())
    this.#failures.set(remote, failures)
  }

  #handshake(ws: WebSocket, request: IncomingMessage): void {
    const remote = request.socket.remoteAddress ?? ''
    this.#pendingHandshakes += 1
    this.#alive.set(ws, true)
    ws.on('pong', () => this.#alive.set(ws, true))
    let settled = false
    const settle = () => {
      if (settled) return false
      settled = true
      this.#pendingHandshakes -= 1
      clearTimeout(timer)
      return true
    }
    const reject = () => {
      if (!settle()) return
      this.#fail(remote)
      ws.terminate()
    }
    const timer = setTimeout(reject, HANDSHAKE_TIMEOUT_MS)
    ws.on('error', reject)
    ws.on('close', () => settle())
    ws.once('message', (data, isBinary) => {
      if (settled) return
      if (!isBinary || !Buffer.isBuffer(data) || data.length > MAX_HANDSHAKE_BYTES) {
        reject()
        return
      }
      let responder: NoiseResponder
      let remoteKey: Buffer
      let payload: Buffer
      try {
        responder = new NoiseResponder({ staticKey: this.#key() })
        ;({ remoteStaticKey: remoteKey, payload } = responder.readMessage1(data))
      } catch {
        // Not encrypted to this computer's key: nothing to answer.
        reject()
        return
      }
      const answer = this.#admit(remoteKey, payload)
      let session
      try {
        const written = responder.writeMessage2(Buffer.from(JSON.stringify(answer)))
        session = written.session
        ws.send(written.message, { binary: true })
      } catch {
        reject()
        return
      }
      if (!answer.ok) {
        settle()
        this.#fail(remote)
        ws.close(1008, answer.error)
        return
      }
      settle()
      ws.removeAllListeners('error')
      const link = new PhoneLinkSocket(ws, answer.deviceId, session.send, session.receive)
      this.#track(link)
      this.#onConnection(link)
    })
  }

  #admit(remoteKey: Buffer, payload: Buffer): Answer {
    const v = PHONE_LINK_VERSION
    if (!this.#state.enabled) return { v, ok: false, error: 'disabled' }
    let hello: z.infer<typeof HelloSchema>
    try {
      hello = HelloSchema.parse(JSON.parse(payload.toString('utf8')))
    } catch {
      return { v, ok: false, error: 'bad_hello' }
    }
    const publicKey = remoteKey.toString('base64url')
    const name = cleanDeviceName(hello.name)
    const now = Date.now()
    const known = this.#state.devices.find((device) => device.publicKey === publicKey)
    if (known) {
      this.#updateDevice(known.id, { name, lastSeenAt: now })
      return { v, ok: true, deviceId: known.id, serverName: this.#serverName }
    }
    if (hello.pair === undefined) return { v, ok: false, error: 'not_paired' }
    const pairing = this.#pairing
    if (!pairing || pairing.expiresAt <= now || !sameSecret(pairing.secretHash, hello.pair)) {
      return { v, ok: false, error: 'pairing_expired' }
    }
    const device: StoredDevice = {
      id: randomUUID(),
      name,
      publicKey,
      pairedAt: now,
      lastSeenAt: now,
    }
    this.#state = { ...this.#state, devices: [...this.#state.devices, device] }
    this.#save()
    // One code pairs one phone.
    this.#pairing = undefined
    clearTimeout(this.#pairingTimer)
    return { v, ok: true, deviceId: device.id, serverName: this.#serverName }
  }

  #updateDevice(id: string, patch: Partial<StoredDevice>): void {
    this.#state = {
      ...this.#state,
      devices: this.#state.devices.map((device) =>
        device.id === id ? { ...device, ...patch } : device,
      ),
    }
    this.#save()
  }

  #track(link: PhoneLinkSocket): void {
    const links = this.#links.get(link.deviceId) ?? new Set()
    links.add(link)
    this.#links.set(link.deviceId, links)
    this.#changed()
    link.onClose(() => {
      const current = this.#links.get(link.deviceId)
      current?.delete(link)
      if (current?.size === 0) this.#links.delete(link.deviceId)
      if (this.#state.devices.some((device) => device.id === link.deviceId)) {
        this.#updateDevice(link.deviceId, { lastSeenAt: Date.now() })
      }
      this.#changed()
    })
  }
}

function readState(value: string | undefined): StoredState {
  if (value === undefined) return { enabled: false, devices: [] }
  try {
    return StoredStateSchema.parse(JSON.parse(value))
  } catch {
    return { enabled: false, devices: [] }
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function sameSecret(expectedHash: Buffer, offered: string): boolean {
  return timingSafeEqual(expectedHash, digest(offered))
}

function cleanDeviceName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Phone'
}

export function pairingUri(payload: PhonePairingPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${PHONE_PAIRING_SCHEME}://pair?p=${encoded}`
}

/** "Karols-MacBook-Pro.local" reads as "Karols MacBook Pro". */
export function computerName(hostname = os.hostname()): string {
  const name = hostname
    .replace(/\.local$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return name.slice(0, 120) || 'TasteCode computer'
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((total, part) => total * 256 + Number(part), 0)
}

function inRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits)
  return (ipv4Number(address) & mask) >>> 0 === (ipv4Number(base) & mask) >>> 0
}

function isTailnet(address: string): boolean {
  return isIPv4(address) && inRange(address, '100.64.0.0', 10)
}

function isPrivateLan(address: string): boolean {
  return (
    isIPv4(address) &&
    (inRange(address, '10.0.0.0', 8) ||
      inRange(address, '172.16.0.0', 12) ||
      inRange(address, '192.168.0.0', 16))
  )
}

/** Who may even attempt a handshake: this machine, the LAN, link-local, a tailnet. */
export function isReachableAddress(remote: string): boolean {
  const address = remote.startsWith('::ffff:') ? remote.slice('::ffff:'.length) : remote
  if (isIPv4(address)) {
    return (
      inRange(address, '127.0.0.0', 8) ||
      inRange(address, '169.254.0.0', 16) ||
      isPrivateLan(address) ||
      isTailnet(address)
    )
  }
  if (!isIPv6(address)) return false
  const lower = address.toLowerCase()
  return (
    lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
  )
}

/** Where a phone can reach this computer: its local name, then LAN, then tailnet addresses. */
export function phoneAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  hostname = os.hostname(),
): PhoneAddress[] {
  const lan: PhoneAddress[] = []
  const tailnet: PhoneAddress[] = []
  const seen = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || seen.has(entry.address)) continue
      seen.add(entry.address)
      if (isTailnet(entry.address)) tailnet.push({ host: entry.address, kind: 'tailscale' })
      else if (isPrivateLan(entry.address)) lan.push({ host: entry.address, kind: 'lan' })
    }
  }
  const localName = hostname.replace(/\.local$/i, '')
  const named: PhoneAddress[] =
    lan.length > 0 && /^[A-Za-z0-9-]{1,63}$/.test(localName)
      ? [{ host: `${localName}.local`, kind: 'hostname' }]
      : []
  return [...named, ...lan, ...tailnet]
}
