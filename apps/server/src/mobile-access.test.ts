import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { connectionAddresses, listenerAddressAllowed, MobileAccess } from './mobile-access.js'
import { Store } from './store.js'

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
  it('offers Tailscale before LAN and excludes public interfaces', () => {
    expect(connectionAddresses(FAKE_INTERFACES, 4312, new Set(['100.101.22.33']))).toEqual([
      {
        kind: 'tailscale',
        label: 'Tailscale · 100.101.22.33',
        url: 'ws://100.101.22.33:4312',
      },
      { kind: 'lan', label: 'en0 · 192.168.1.44', url: 'ws://192.168.1.44:4312' },
    ])
    expect(connectionAddresses(FAKE_INTERFACES, 4312)).toEqual([
      { kind: 'lan', label: 'en0 · 192.168.1.44', url: 'ws://192.168.1.44:4312' },
    ])
  })

  it('accepts the listener only through loopback or an advertised interface', () => {
    const advertised = connectionAddresses(FAKE_INTERFACES, 4312, new Set(['100.101.22.33']))
    expect(listenerAddressAllowed('127.0.0.1', advertised)).toBe(true)
    expect(listenerAddressAllowed('::ffff:192.168.1.44', advertised)).toBe(true)
    expect(listenerAddressAllowed('8.8.8.8', advertised)).toBe(false)
  })

  it('invalidates a QR ticket when Settings generates a replacement', async () => {
    const store = new Store(':memory:')
    const access = new MobileAccess({
      store,
      port: 0,
      networkInterfaces: () => FAKE_INTERFACES,
      resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
      onConnection: () => undefined,
    })

    try {
      const first = await access.startPairing()
      const firstTicket = pairingTicket(first.pairingUri)
      const second = await access.startPairing()
      const secondTicket = pairingTicket(second.pairingUri)

      expect(access.authorize(`/?pairing_ticket=${firstTicket}`)).toBeUndefined()
      expect(access.authorize(`/?pairing_ticket=${secondTicket}`)?.kind).toBe('pairing')
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('keeps persisted state aligned when no private route can be advertised', async () => {
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
      expect(access.status()).toMatchObject({ enabled: false, addresses: [] })
      await expect(access.startPairing()).rejects.toThrow('No Tailscale or private LAN address')
      expect(store.mobileAccessEnabled()).toBe(false)
      expect(access.status()).toMatchObject({ enabled: false, addresses: [] })
    } finally {
      await access.stop()
      store.close()
    }
  })

  it('exchanges a single-use QR ticket for a revocable durable token', async () => {
    const store = new Store(':memory:')
    const access = new MobileAccess({
      store,
      port: 0,
      serverName: 'Karol MacBook',
      networkInterfaces: () => FAKE_INTERFACES,
      resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
      onConnection: () => undefined,
    })

    try {
      const offer = await access.startPairing()
      expect(offer.enabled).toBe(true)
      expect(offer.port).toBeGreaterThan(0)
      expect(offer.pairingUri).toMatch(/^harness:\/\/pair\?payload=/)

      const encoded = new URL(offer.pairingUri).searchParams.get('payload')
      expect(encoded).toBeTruthy()
      const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString()) as {
        ticket: string
        serverName: string
      }
      expect(payload.serverName).toBe('Karol MacBook')

      const bootstrap = access.authorize(`/?pairing_ticket=${encodeURIComponent(payload.ticket)}`)
      expect(bootstrap?.kind).toBe('pairing')
      if (!bootstrap) throw new Error('missing bootstrap access')

      const failedInsert = vi.spyOn(store, 'pairDevice').mockImplementationOnce(() => {
        throw new Error('database is temporarily unavailable')
      })
      expect(() => access.claim(bootstrap, 'Karol’s iPhone')).toThrow(
        'database is temporarily unavailable',
      )
      failedInsert.mockRestore()
      expect(access.authorize(`/?pairing_ticket=${encodeURIComponent(payload.ticket)}`)).toEqual(
        bootstrap,
      )

      const claimed = access.claim(bootstrap, 'Karol’s iPhone')
      expect(claimed.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(store.pairedDevices()).toMatchObject([
        { id: claimed.deviceId, name: 'Karol’s iPhone' },
      ])
      expect(
        access.authorize(`/?pairing_ticket=${encodeURIComponent(payload.ticket)}`),
      ).toBeUndefined()
      expect(access.authorize(`/?token=${encodeURIComponent(claimed.deviceToken)}`)).toEqual({
        kind: 'device',
        deviceId: claimed.deviceId,
      })
      expect(access.isDeviceActive(claimed.deviceId)).toBe(true)

      access.revoke(claimed.deviceId)
      expect(access.isDeviceActive(claimed.deviceId)).toBe(false)
      expect(access.authorize(`/?token=${encodeURIComponent(claimed.deviceToken)}`)).toBeUndefined()
    } finally {
      await access.stop()
      store.close()
    }
  })
})

function pairingTicket(pairingUri: string): string {
  const encoded = new URL(pairingUri).searchParams.get('payload')
  if (!encoded) throw new Error('missing pairing payload')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket?: unknown }
  if (typeof payload.ticket !== 'string') throw new Error('missing pairing ticket')
  return payload.ticket
}
