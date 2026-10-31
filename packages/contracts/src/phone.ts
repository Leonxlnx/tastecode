import { z } from 'zod'

/**
 * Phone access: a paired phone is one more client of the core server, over an
 * end-to-end encrypted link on the local network or a tailnet. The link itself
 * (Noise IK handshake, encrypted frames) is described in ARCHITECTURE.md; these
 * schemas are what the desktop shows and changes about it.
 */

/** Pairing links are opened by the TasteCode phone app; the scheme is its own. */
export const PHONE_PAIRING_SCHEME = 'tastecode'
export const PHONE_LINK_VERSION = 1
/** The WebSocket path the phone listener accepts links on. */
export const PHONE_LINK_PATH = '/link'

/** Unpadded base64url of exactly 32 bytes, the shape of an X25519 key. */
export const PhoneKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'expected a 32-byte base64url key')

export const PhoneAddressSchema = z.object({
  host: z.string().min(1).max(253),
  /** `hostname` is the computer's own name on the local network (`name.local`). */
  kind: z.enum(['lan', 'tailscale', 'hostname']),
})
export type PhoneAddress = z.infer<typeof PhoneAddressSchema>

export const PhoneDeviceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  pairedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().optional(),
  /** At least one encrypted link from this phone is open right now. */
  connected: z.boolean(),
})
export type PhoneDevice = z.infer<typeof PhoneDeviceSchema>

export const PhoneAccessStatusSchema = z.object({
  /**
   * False when this build keeps phone access off: the listener cannot start
   * and the desktop hides the feature. Absent (older servers) means available.
   */
  available: z.boolean().optional(),
  /** The user turned phone access on. Persisted across restarts. */
  enabled: z.boolean(),
  /** The listener accepts links right now. False while enabled means `error` says why. */
  listening: z.boolean(),
  port: z.number().int().min(1).max(65_535),
  /** What the phone calls this computer. */
  serverName: z.string().min(1).max(120),
  /** Where a phone can reach this computer, most specific first. */
  addresses: z.array(PhoneAddressSchema),
  devices: z.array(PhoneDeviceSchema),
  /**
   * A pairing code is open until this time. The link itself, which carries the
   * one-time secret, is only in `phone.startPairing`'s answer.
   */
  pairingExpiresAt: z.number().int().nonnegative().optional(),
  /** Why the listener could not start, in words the desktop can show. */
  error: z.string().min(1).optional(),
})
export type PhoneAccessStatus = z.infer<typeof PhoneAccessStatusSchema>

export const PhonePairingSchema = z.object({
  /** `tastecode://pair?…` — shown as a QR code and openable on the phone. */
  uri: z.string().min(1).max(4096),
  expiresAt: z.number().int().nonnegative(),
})
export type PhonePairing = z.infer<typeof PhonePairingSchema>

/**
 * What a pairing link carries. Everything a phone needs to find and verify
 * this computer: the static key pins the link, so no address in it has to be
 * trusted, and the secret is good for one pairing before `expiresAt`.
 */
export const PhonePairingPayloadSchema = z.object({
  v: z.literal(PHONE_LINK_VERSION),
  name: z.string().min(1).max(120),
  key: PhoneKeySchema,
  port: z.number().int().min(1).max(65_535),
  hosts: z.array(z.string().min(1).max(253)).min(1).max(16),
  secret: PhoneKeySchema,
  expiresAt: z.number().int().nonnegative(),
})
export type PhonePairingPayload = z.infer<typeof PhonePairingPayloadSchema>

/** One folder entry of `projects.browse`. Files are never listed. */
export const BrowsedFolderSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /** Holds a `.git` entry, so it is most likely a project root. */
  repository: z.boolean(),
  /** Already a project in TasteCode. */
  added: z.boolean(),
})
export type BrowsedFolder = z.infer<typeof BrowsedFolderSchema>

export const ProjectBrowseResultSchema = z.object({
  path: z.string().min(1),
  /** Absent at a filesystem root. */
  parent: z.string().min(1).optional(),
  home: z.string().min(1),
  /** Places to start from: the home folder, and the drives on Windows. */
  roots: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })),
  folders: z.array(BrowsedFolderSchema),
  /** More folders exist than were returned. */
  truncated: z.boolean(),
})
export type ProjectBrowseResult = z.infer<typeof ProjectBrowseResultSchema>
