import type { ProviderId } from '@harness/contracts'

/** Settings and lifecycle capabilities; importing this table never loads a vendor SDK. */
export type ProviderControlCapabilities = Readonly<{
  resume: boolean
  managedMcp: boolean
  inheritedMcp: boolean
  nativeSkills: boolean
  nativeModels: boolean
  notifications: boolean
  skillsInstall: boolean
  account: boolean
  login: boolean
  apiKey: boolean
  signOut: boolean
  usageLimits: boolean
  rateLimitReset: boolean
  /**
   * Minimum spacing of full plan-limit reads, each of which starts a vendor
   * process. A successful read answers at least this long, and a usage change
   * cannot force an earlier one.
   */
  limitReadIntervalMs: number
  /** Timed-out limit reads after which the server stops reading until the account changes. */
  limitReadTimeoutLimit?: number
  /**
   * Full reads wait for a client that shows the limits (`visible` or `retry`
   * intent). A passive figure is answered from held values only, which live
   * windows from running sessions keep current.
   */
  limitReadsWhenShown?: boolean
}>

const unsupported: ProviderControlCapabilities = {
  resume: false,
  managedMcp: false,
  inheritedMcp: false,
  nativeSkills: false,
  nativeModels: false,
  notifications: false,
  skillsInstall: false,
  account: false,
  login: false,
  apiKey: false,
  signOut: false,
  usageLimits: false,
  rateLimitReset: false,
  limitReadIntervalMs: 0,
}

/** Codex and Grok start a short-lived process per read and report changes during turns. */
const LIVE_LIMIT_READ_INTERVAL_MS = 30_000

export const PROVIDER_CAPABILITIES = {
  acp: { ...unsupported, resume: true, nativeModels: true, account: true, signOut: true },
  antigravity: { ...unsupported, nativeModels: true },
  api: { ...unsupported, resume: true },
  'claude-code': {
    ...unsupported,
    resume: true,
    managedMcp: true,
    nativeModels: true,
    account: true,
    login: true,
    signOut: true,
    usageLimits: true,
    // Each read starts a full Claude CLI, and every turn reports a usage change.
    limitReadIntervalMs: 15 * 60_000,
    // A CLI that still scans its transcripts misses the read deadline every
    // time; two misses are enough to stop paying for that scan.
    limitReadTimeoutLimit: 2,
    // Each read starts a whole CLI; rate_limit_event keeps the session window current.
    limitReadsWhenShown: true,
  },
  codex: {
    resume: true,
    managedMcp: true,
    inheritedMcp: true,
    nativeSkills: true,
    nativeModels: true,
    notifications: true,
    skillsInstall: true,
    account: true,
    login: true,
    apiKey: true,
    signOut: true,
    usageLimits: true,
    rateLimitReset: true,
    limitReadIntervalMs: LIVE_LIMIT_READ_INTERVAL_MS,
  },
  cursor: {
    ...unsupported,
    resume: true,
    nativeModels: true,
    account: true,
    login: true,
    signOut: true,
  },
  grok: {
    ...unsupported,
    resume: true,
    managedMcp: true,
    nativeModels: true,
    account: true,
    signOut: true,
    usageLimits: true,
    limitReadIntervalMs: LIVE_LIMIT_READ_INTERVAL_MS,
  },
  opencode: { ...unsupported, resume: true, managedMcp: true, nativeModels: true },
  pi: { ...unsupported, nativeModels: true },
} as const satisfies Readonly<Record<ProviderId, ProviderControlCapabilities>>
