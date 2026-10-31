import { Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { PhonePairingPayloadSchema, type PhoneAccessStatus } from '@harness/contracts'
import {
  isReachableAddress,
  PHONE_ACCESS_UNAVAILABLE,
  PhoneAccess,
  phoneAccessAvailable,
  phoneAddresses,
  type PhoneLinkSocket,
} from './phone-access.js'
import {
  generateNoiseKeyPair,
  NoiseInitiator,
  type NoiseKeyPair,
  type NoiseSession,
} from './phone-noise.js'

const lanInterfaces = () => ({
  en0: [
    {
      address: '192.168.1.20',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: '192.168.1.20/24',
    },
  ],
})

type Harness = {
  access: PhoneAccess
  links: PhoneLinkSocket[]
  changes: PhoneAccessStatus[]
  state: StoredValue
  keyWrites: string[]
}

type StoredValue = { value: string | undefined }

const opened: PhoneAccess[] = []

function harness(options: { available?: boolean; stored?: string } = {}): Harness {
  const links: PhoneLinkSocket[] = []
  const changes: PhoneAccessStatus[] = []
  const state: StoredValue = { value: options.stored }
  const keyWrites: string[] = []
  let key: string | undefined
  const access = new PhoneAccess({
    available: options.available ?? true,
    store: {
      phoneAccessState: () => state.value,
      setPhoneAccessState: (value) => {
        state.value = value
      },
    },
    keys: {
      read: () => key,
      write: (value) => {
        key = value
        keyWrites.push(value)
      },
    },
    port: 0,
    host: '127.0.0.1',
    serverName: 'Studio Mac',
    networkInterfaces: lanInterfaces,
    onConnection: (link) => links.push(link),
    onChanged: (status) => changes.push(status),
  })
  opened.push(access)
  return { access, links, changes, state, keyWrites }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(opened.splice(0).map((access) => access.close()))
})

function payloadOf(uri: string) {
  const encoded = new URL(uri).searchParams.get('p') ?? ''
  return PhonePairingPayloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()))
}

type Linked = {
  answer: Record<string, unknown>
  socket: WebSocket
  session: NoiseSession
  closed: Promise<number>
}

async function link(
  port: number,
  serverKey: string,
  phone: NoiseKeyPair,
  hello: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Linked> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/link`, { headers })
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  const initiator = new NoiseInitiator({
    staticKey: phone,
    remoteStaticKey: Buffer.from(serverKey, 'base64url'),
  })
  socket.send(initiator.writeMessage1(Buffer.from(JSON.stringify(hello))))
  const reply = await new Promise<Buffer>((resolve) =>
    socket.once('message', (data) => resolve(Buffer.from(data as Buffer))),
  )
  const { payload, session } = initiator.readMessage2(reply)
  return { answer: JSON.parse(payload.toString()), socket, session, closed }
}

function nextFrame(linked: Linked): Promise<string> {
  return new Promise((resolve) =>
    linked.socket.once('message', (data) =>
      resolve(linked.session.receive.decrypt(Buffer.from(data as Buffer)).toString()),
    ),
  )
}

describe('phone access', () => {
  it('stays off until the user turns it on', async () => {
    const { access } = harness()
    await access.resume()
    expect(access.status()).toMatchObject({ enabled: false, listening: false, addresses: [] })
  })

  it('pairs a phone with a one-time code and then carries encrypted frames both ways', async () => {
    const { access, links, state } = harness()
    const { pairing, status } = await access.startPairing()
    expect(status).toMatchObject({ enabled: true, listening: true, serverName: 'Studio Mac' })
    expect(status.pairingExpiresAt).toBe(pairing.expiresAt)
    const payload = payloadOf(pairing.uri)
    expect(payload.hosts).toContain('192.168.1.20')

    const phone = generateNoiseKeyPair()
    const linked = await link(status.port, payload.key, phone, {
      v: 1,
      name: '  Karol’s   iPhone ',
      pair: payload.secret,
    })
    expect(linked.answer).toMatchObject({ ok: true, serverName: 'Studio Mac' })
    expect(links).toHaveLength(1)
    const [server] = links
    expect(access.status().devices).toEqual([
      expect.objectContaining({ name: 'Karol’s iPhone', connected: true }),
    ])
    expect(access.status().pairingExpiresAt).toBeUndefined()
    // The device record holds a public key only.
    expect(state.value).toContain(phone.publicKey.toString('base64url'))
    expect(state.value).not.toContain(phone.privateKey.toString('base64url'))

    const received = new Promise<string>((resolve) => server!.onMessage(resolve))
    linked.socket.send(linked.session.send.encrypt(Buffer.from('{"id":"1","method":"x"}')))
    expect(await received).toBe('{"id":"1","method":"x"}')

    const frame = nextFrame(linked)
    server!.send('{"channel":"phone.changed","sequence":1,"data":{}}')
    server!.send('{"channel":"thread.event","sequence":2,"data":{}}')
    // The phone never hears its own pairing state.
    expect(await frame).toBe('{"channel":"thread.event","sequence":2,"data":{}}')
    linked.socket.close()
  })

  it('lets a paired phone back in without a code and refuses everyone else', async () => {
    const { access } = harness()
    const { pairing, status } = await access.startPairing()
    const payload = payloadOf(pairing.uri)
    const phone = generateNoiseKeyPair()
    const first = await link(status.port, payload.key, phone, {
      v: 1,
      name: 'iPhone',
      pair: payload.secret,
    })
    expect(first.answer).toMatchObject({ ok: true })
    first.socket.close()

    const again = await link(status.port, payload.key, phone, { v: 1, name: 'iPhone' })
    expect(again.answer).toMatchObject({ ok: true, deviceId: first.answer['deviceId'] })
    again.socket.close()

    const stranger = await link(status.port, payload.key, generateNoiseKeyPair(), {
      v: 1,
      name: 'Other',
    })
    expect(stranger.answer).toEqual({ v: 1, ok: false, error: 'not_paired' })
    expect(await stranger.closed).toBe(1008)

    // The code was spent by the first phone.
    const late = await link(status.port, payload.key, generateNoiseKeyPair(), {
      v: 1,
      name: 'Late',
      pair: payload.secret,
    })
    expect(late.answer).toEqual({ v: 1, ok: false, error: 'pairing_expired' })
  })

  it('refuses connections a browser page could open', async () => {
    const { access } = harness()
    const { pairing, status } = await access.startPairing()
    const payload = payloadOf(pairing.uri)
    await expect(
      link(
        status.port,
        payload.key,
        generateNoiseKeyPair(),
        { v: 1, name: 'Page', pair: payload.secret },
        { Origin: 'https://example.com' },
      ),
    ).rejects.toThrow(/403/)
  })

  it('closes a removed phone and does not let it back in', async () => {
    const { access, links } = harness()
    const { pairing, status } = await access.startPairing()
    const payload = payloadOf(pairing.uri)
    const phone = generateNoiseKeyPair()
    const linked = await link(status.port, payload.key, phone, {
      v: 1,
      name: 'iPhone',
      pair: payload.secret,
    })
    const deviceId = String(linked.answer['deviceId'])
    access.removeDevice(deviceId)
    await linked.closed
    expect(links[0]?.readyState).toBe(3)
    expect(access.status().devices).toEqual([])
    const again = await link(status.port, payload.key, phone, { v: 1, name: 'iPhone' })
    expect(again.answer).toMatchObject({ ok: false, error: 'not_paired' })
  })

  it('closes every link when turned off and keeps the phone paired', async () => {
    const { access } = harness()
    const { pairing, status } = await access.startPairing()
    const payload = payloadOf(pairing.uri)
    const linked = await link(status.port, payload.key, generateNoiseKeyPair(), {
      v: 1,
      name: 'iPhone',
      pair: payload.secret,
    })
    const off = await access.setEnabled(false)
    await linked.closed
    expect(off).toMatchObject({ enabled: false, listening: false })
    expect(off.devices).toEqual([expect.objectContaining({ name: 'iPhone', connected: false })])
  })

  it('drops a link whose frame fails authentication', async () => {
    const { access, links } = harness()
    const { pairing, status } = await access.startPairing()
    const payload = payloadOf(pairing.uri)
    const linked = await link(status.port, payload.key, generateNoiseKeyPair(), {
      v: 1,
      name: 'iPhone',
      pair: payload.secret,
    })
    const forged = linked.session.send.encrypt(Buffer.from('{}'))
    forged[forged.length - 1]! ^= 1
    linked.socket.send(forged)
    await linked.closed
    expect(links[0]?.readyState).toBe(3)
  })
})

describe('phone access in a build without it', () => {
  // What an earlier dev build left behind: access on and one paired phone.
  const leftOn = JSON.stringify({
    enabled: true,
    devices: [{ id: 'd1', name: 'iPhone', publicKey: 'A'.repeat(43), pairedAt: 1 }],
  })

  it('is offered only when HARNESS_PHONE_ACCESS is exactly 1', () => {
    expect(phoneAccessAvailable({ HARNESS_PHONE_ACCESS: '1' })).toBe(true)
    expect(phoneAccessAvailable({})).toBe(false)
    expect(phoneAccessAvailable({ HARNESS_PHONE_ACCESS: '' })).toBe(false)
    expect(phoneAccessAvailable({ HARNESS_PHONE_ACCESS: '0' })).toBe(false)
    expect(phoneAccessAvailable({ HARNESS_PHONE_ACCESS: 'true' })).toBe(false)
  })

  it('never opens the listener, even when an earlier build left access on', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen')
    const { access, state, keyWrites } = harness({ available: false, stored: leftOn })

    await expect(access.resume()).rejects.toThrow(PHONE_ACCESS_UNAVAILABLE)
    await expect(access.setEnabled(true)).rejects.toThrow(PHONE_ACCESS_UNAVAILABLE)
    await expect(access.startPairing()).rejects.toThrow(PHONE_ACCESS_UNAVAILABLE)

    expect(listen).not.toHaveBeenCalled()
    // No phone link key is read or made, so nothing touches the keychain either.
    expect(keyWrites).toEqual([])
    // The refusals change nothing a later dev build would read.
    expect(state.value).toBe(leftOn)
    expect(access.status()).toEqual({
      available: false,
      enabled: false,
      listening: false,
      port: 0,
      serverName: 'Studio Mac',
      addresses: [],
      devices: [{ id: 'd1', name: 'iPhone', pairedAt: 1, connected: false }],
    })
  })

  it('still turns access off, cancels a code and forgets a phone', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen')
    const { access, state, changes } = harness({ available: false, stored: leftOn })

    expect(access.cancelPairing()).toMatchObject({ available: false, listening: false })
    expect(access.removeDevice('d1').devices).toEqual([])
    const off = await access.setEnabled(false)
    expect(off).toMatchObject({ available: false, enabled: false, listening: false })
    expect(JSON.parse(state.value ?? '')).toEqual({ enabled: false, devices: [] })
    expect(changes.every((status) => status.available === false && !status.listening)).toBe(true)
    expect(listen).not.toHaveBeenCalled()
  })

  it('says it is available when it is, and only then listens', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen')
    const { access } = harness()
    expect(access.status()).toMatchObject({ available: true, listening: false })
    const { status } = await access.startPairing()
    expect(status).toMatchObject({ available: true, enabled: true, listening: true })
    expect(listen).toHaveBeenCalledTimes(1)
  })
})

describe('phone addresses', () => {
  it('offers the local name, then LAN, then tailnet addresses', () => {
    const interfaces = {
      ...lanInterfaces(),
      utun4: [
        {
          address: '100.101.102.103',
          netmask: '255.255.255.255',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '100.101.102.103/32',
        },
      ],
      en5: [
        {
          address: '203.0.113.9',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '203.0.113.9/24',
        },
      ],
    }
    expect(phoneAddresses(interfaces, 'Studio-Mac.local')).toEqual([
      { host: 'Studio-Mac.local', kind: 'hostname' },
      { host: '192.168.1.20', kind: 'lan' },
      { host: '100.101.102.103', kind: 'tailscale' },
    ])
  })

  it('answers only private, tailnet and loopback peers', () => {
    expect(isReachableAddress('192.168.0.4')).toBe(true)
    expect(isReachableAddress('::ffff:10.1.2.3')).toBe(true)
    expect(isReachableAddress('172.20.0.1')).toBe(true)
    expect(isReachableAddress('100.64.1.1')).toBe(true)
    expect(isReachableAddress('127.0.0.1')).toBe(true)
    expect(isReachableAddress('fe80::1')).toBe(true)
    expect(isReachableAddress('172.32.0.1')).toBe(false)
    expect(isReachableAddress('8.8.8.8')).toBe(false)
    expect(isReachableAddress('2001:db8::1')).toBe(false)
  })
})
