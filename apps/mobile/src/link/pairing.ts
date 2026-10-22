import type { PhonePairingPayload } from '@harness/contracts'
import { TasteLink } from '../../modules/tastecode-link'

/** The computer this phone is paired with, as kept in the Keychain. */
export type Pairing = {
  name: string
  /** The computer's static key, base64url. Every link is pinned to it. */
  key: string
  port: number
  hosts: string[]
  /** The address that answered last, tried first next time. */
  lastHost?: string
  /** Present until the first link uses it; one pairing secret pairs one phone. */
  secret?: string
  deviceId?: string
  pairedAt?: number
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export class PairingLinkError extends Error {
  override name = 'PairingLinkError'
}

/**
 * Reads a `tastecode://pair?p=…` link (from the QR code, a pasted link or the
 * system camera). A pasted link may arrive inside a message sent to oneself, so
 * it is found anywhere in the text. Fails with a sentence the pairing screen can show.
 */
export function parsePairingLink(text: string, now = Date.now()): Pairing {
  const match = /tastecode:\/\/pair\?(?:[^\s&]*&)*p=([A-Za-z0-9_-]+)/.exec(text)
  if (!match?.[1]) throw new PairingLinkError('That is not a TasteCode pairing code.')
  let payload: Partial<PhonePairingPayload>
  try {
    payload = JSON.parse(decodeBase64Url(match[1])) as Partial<PhonePairingPayload>
  } catch {
    throw new PairingLinkError(
      'The pairing code could not be read. Show a new one on the computer.',
    )
  }
  if (payload.v !== 1) {
    throw new PairingLinkError('This pairing code is from a newer TasteCode. Update the app.')
  }
  const { name, key, port, hosts, secret, expiresAt } = payload
  if (
    typeof name !== 'string' ||
    typeof key !== 'string' ||
    !KEY_PATTERN.test(key) ||
    typeof secret !== 'string' ||
    !KEY_PATTERN.test(secret) ||
    typeof port !== 'number' ||
    !Array.isArray(hosts) ||
    hosts.length === 0 ||
    !hosts.every((host) => typeof host === 'string' && host.length > 0)
  ) {
    throw new PairingLinkError('The pairing code is incomplete. Show a new one on the computer.')
  }
  if (typeof expiresAt === 'number' && expiresAt < now) {
    throw new PairingLinkError('This pairing code has expired. Show a new one on the computer.')
  }
  return { name, key, port, hosts, secret }
}

export function loadPairing(): Pairing | undefined {
  const stored = TasteLink.readPairing()
  if (!stored) return undefined
  try {
    const pairing = JSON.parse(stored) as Pairing
    return KEY_PATTERN.test(pairing.key) && pairing.hosts.length > 0 ? pairing : undefined
  } catch {
    return undefined
  }
}

export function savePairing(pairing: Pairing): void {
  TasteLink.writePairing(JSON.stringify(pairing))
}

/** The last address that worked first, then the rest in the computer's order. */
export function orderedHosts(pairing: Pairing): string[] {
  const { lastHost, hosts } = pairing
  return lastHost && hosts.includes(lastHost)
    ? [lastHost, ...hosts.filter((host) => host !== lastHost)]
    : hosts
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Base64url to a UTF-8 string, without relying on `atob` or `TextDecoder`. */
export function decodeBase64Url(value: string): string {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of value) {
    const index = ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Invalid base64url')
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''))
}
