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
}

export const PROVIDER_CAPABILITIES = {
  acp: { ...unsupported, resume: true, nativeModels: true, account: true, signOut: true },
  antigravity: { ...unsupported, nativeModels: true },
  api: { ...unsupported },
  'claude-code': {
    ...unsupported,
    resume: true,
    managedMcp: true,
    nativeModels: true,
    account: true,
    login: true,
    signOut: true,
    usageLimits: true,
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
  },
  opencode: { ...unsupported, resume: true, managedMcp: true, nativeModels: true },
  pi: { ...unsupported, nativeModels: true },
} as const satisfies Readonly<Record<ProviderId, ProviderControlCapabilities>>
