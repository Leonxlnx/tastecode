import { describe, expect, it } from 'vitest'
import { PhonePairingPayloadSchema, PhoneKeySchema, ProjectBrowseResultSchema } from './phone.js'
import { channels, methods } from './protocol.js'

const key = 'A'.repeat(43)

describe('phone access contracts', () => {
  it('accepts only 32-byte base64url keys', () => {
    expect(PhoneKeySchema.safeParse(key).success).toBe(true)
    expect(PhoneKeySchema.safeParse(`${key}=`).success).toBe(false)
    expect(PhoneKeySchema.safeParse('A'.repeat(42)).success).toBe(false)
    expect(PhoneKeySchema.safeParse(`${'A'.repeat(42)}+`).success).toBe(false)
  })

  it('requires a host, the pinned key and a one-time secret in a pairing link', () => {
    const payload = {
      v: 1,
      name: 'Studio Mac',
      key,
      port: 4317,
      hosts: ['studio.local', '192.168.1.20'],
      secret: key,
      expiresAt: 1,
    }
    expect(PhonePairingPayloadSchema.parse(payload)).toEqual(payload)
    expect(PhonePairingPayloadSchema.safeParse({ ...payload, hosts: [] }).success).toBe(false)
    expect(PhonePairingPayloadSchema.safeParse({ ...payload, v: 2 }).success).toBe(false)
    const { secret: _secret, ...withoutSecret } = payload
    expect(PhonePairingPayloadSchema.safeParse(withoutSecret).success).toBe(false)
  })

  it('keeps the pairing secret out of the broadcast status', () => {
    const status = {
      enabled: true,
      listening: true,
      port: 4317,
      serverName: 'Studio Mac',
      addresses: [{ host: '192.168.1.20', kind: 'lan' }],
      devices: [{ id: 'd1', name: 'iPhone', pairedAt: 1, connected: true }],
      pairingExpiresAt: 2,
    }
    const parsed = channels['phone.changed'].parse({ ...status, uri: 'tastecode://pair?x' })
    expect(parsed).toEqual(status)
    expect(
      methods['phone.startPairing'].result.parse({
        status,
        pairing: { uri: 'tastecode://pair?x', expiresAt: 2 },
      }).pairing.uri,
    ).toBe('tastecode://pair?x')
  })

  it('reads a missing availability flag as available, so older servers still parse', () => {
    const status = {
      enabled: false,
      listening: false,
      port: 4317,
      serverName: 'Studio Mac',
      addresses: [],
      devices: [],
    }
    expect(methods['phone.status'].result.parse(status).available).toBeUndefined()
    expect(methods['phone.status'].result.parse({ ...status, available: false })).toEqual({
      ...status,
      available: false,
    })
    expect(channels['phone.changed'].parse({ ...status, available: true }).available).toBe(true)
    expect(methods['phone.status'].result.safeParse({ ...status, available: 'no' }).success).toBe(
      false,
    )
  })

  it('lists folders without files and names the starting places', () => {
    const result = {
      path: '/Users/me',
      parent: '/Users',
      home: '/Users/me',
      roots: [{ name: 'Home', path: '/Users/me' }],
      folders: [{ name: 'app', path: '/Users/me/app', repository: true, added: false }],
      truncated: false,
    }
    expect(ProjectBrowseResultSchema.parse(result)).toEqual(result)
    expect(methods['projects.browse'].params.parse({})).toEqual({})
    expect(methods['projects.browse'].params.safeParse({ path: '' }).success).toBe(false)
  })

  it('announces list changes without a payload', () => {
    expect(channels['projects.changed'].parse({})).toEqual({})
  })
})
