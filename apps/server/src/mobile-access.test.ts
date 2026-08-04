import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { connectionAddresses, listenerAddressAllowed, MobileAccess } from './mobile-access.js'
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
})

function createAccess(store: Store): MobileAccess {
  return new MobileAccess({
    store,
    port: 0,
    serverName: 'Test computer',
    networkInterfaces: () => INTERFACES,
    resolveTailscaleAddresses: async () => new Set(['100.101.22.33']),
    onConnection: () => undefined,
  })
}

function pairingTicket(uri: string): string {
  const encoded = new URL(uri).searchParams.get('payload')
  if (!encoded) throw new Error('missing pairing payload')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket?: unknown }
  if (typeof payload.ticket !== 'string') throw new Error('missing pairing ticket')
  return payload.ticket
}
