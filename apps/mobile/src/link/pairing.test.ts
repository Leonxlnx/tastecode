import { describe, expect, it, vi } from 'vitest'

vi.mock('../../modules/tastecode-link', () => ({ TasteLink: {} }))

const { decodeBase64Url, orderedHosts, PairingLinkError, parsePairingLink } =
  await import('./pairing')

const key = 'z74F_ghPH4LK_z9BA7dTR8HHnDAhxJ0q3ao9RvvJxXU'

function base64Url(text: string): string {
  const binary = Array.from(new TextEncoder().encode(text), (byte) =>
    String.fromCharCode(byte),
  ).join('')
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function link(payload: Record<string, unknown>): string {
  return `tastecode://pair?p=${base64Url(JSON.stringify(payload))}`
}

const payload = {
  v: 1,
  name: 'Karol’s Mac',
  key,
  port: 4317,
  hosts: ['studio.local', '192.168.1.20'],
  secret: key,
  expiresAt: 2_000,
}

describe('pairing links', () => {
  it('reads what the desktop puts in the code, including non-ASCII names', () => {
    expect(parsePairingLink(link(payload), 1_000)).toEqual({
      name: 'Karol’s Mac',
      key,
      port: 4317,
      hosts: ['studio.local', '192.168.1.20'],
      secret: key,
    })
  })

  it('refuses anything else with a sentence the screen can show', () => {
    expect(() => parsePairingLink('https://example.com', 1_000)).toThrow(PairingLinkError)
    expect(() => parsePairingLink(link({ ...payload, v: 2 }), 1_000)).toThrow(/newer TasteCode/)
    expect(() => parsePairingLink(link({ ...payload, hosts: [] }), 1_000)).toThrow(/incomplete/)
    expect(() => parsePairingLink(link({ ...payload, key: 'short' }), 1_000)).toThrow(/incomplete/)
    expect(() => parsePairingLink(link(payload), 3_000)).toThrow(/expired/)
    expect(() => parsePairingLink('tastecode://pair?p=!!!', 1_000)).toThrow(PairingLinkError)
  })

  it('decodes base64url without the platform decoders', () => {
    expect(decodeBase64Url(base64Url('Grüße, 世界'))).toBe('Grüße, 世界')
  })

  it('tries the address that worked last first', () => {
    const pairing = { name: 'Mac', key, port: 1, hosts: ['a.local', '10.0.0.2', '100.64.0.9'] }
    expect(orderedHosts({ ...pairing, lastHost: '100.64.0.9' })).toEqual([
      '100.64.0.9',
      'a.local',
      '10.0.0.2',
    ])
    expect(orderedHosts({ ...pairing, lastHost: 'gone' })).toEqual(pairing.hosts)
  })
})
