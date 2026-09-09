import type {
  Capabilities,
  MethodName,
  ProviderId,
  ProviderSetup,
  ProviderStatus,
  ResultOf,
  ThreadInboxStatus,
  ThreadLifecycle,
} from '@harness/contracts'
import {
  arrayOf,
  enumValidator,
  isBoolean,
  isFiniteNumber,
  isNonnegativeInteger,
  isRecord,
  isString,
  objectValidator,
  optional,
} from './fast-validation.js'

/** Parse startup-critical replies without waiting for the full contract chunk. */
export function parseStartupMethodResult<M extends MethodName>(
  method: M,
  value: unknown,
): ResultOf<M> | undefined {
  if (method === 'projects.list') return parseProjectsListResult(value) as ResultOf<M> | undefined
  if (method === 'providers.list') return parseProvidersListResult(value) as ResultOf<M> | undefined
  return undefined
}

const isProviderId = enumValidator<ProviderId>({
  codex: true,
  'claude-code': true,
  grok: true,
  cursor: true,
  opencode: true,
  antigravity: true,
  pi: true,
  acp: true,
  api: true,
})
const isInboxStatus = enumValidator<ThreadInboxStatus>({
  starting: true,
  working: true,
  queued: true,
  approval: true,
  input: true,
  failed: true,
  ready: true,
  idle: true,
})
const isActive = objectValidator<Extract<ThreadLifecycle, { state: 'active' }>>({
  state: (value) => value === 'active',
  keepActive: isBoolean,
  wokeAt: optional(isNonnegativeInteger),
})
const isSettled = objectValidator<Extract<ThreadLifecycle, { state: 'settled' }>>({
  state: (value) => value === 'settled',
  settledAt: isNonnegativeInteger,
  reason: enumValidator<Extract<ThreadLifecycle, { state: 'settled' }>['reason']>({
    manual: true,
    inactivity: true,
    change_request: true,
  }),
})
const isSnoozed = objectValidator<Extract<ThreadLifecycle, { state: 'snoozed' }>>({
  state: (value) => value === 'snoozed',
  snoozedAt: isNonnegativeInteger,
  wakeAt: isNonnegativeInteger,
})
const lifecycleValidators = {
  active: isActive,
  settled: isSettled,
  snoozed: isSnoozed,
} satisfies Record<ThreadLifecycle['state'], (value: unknown) => boolean>
const isLifecycle = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    typeof value['state'] !== 'string' ||
    !Object.hasOwn(lifecycleValidators, value['state'])
  )
    return false
  return lifecycleValidators[value['state'] as ThreadLifecycle['state']](value)
}

const isCapabilities = objectValidator<Capabilities>({
  steer: isBoolean,
  fork: isBoolean,
  interrupt: isBoolean,
  reasoningItems: isBoolean,
  approvals: isBoolean,
  userInput: optional(isBoolean),
  autoReview: optional(isBoolean),
  images: isBoolean,
})
const isSetup = objectValidator<ProviderSetup>({
  installUrl: isUrl,
  installCommand: optional(isString),
  login: enumValidator<ProviderSetup['login']>({ app: true, provider: true }),
  loginOpensBrowser: optional(isBoolean),
})
const isProvider = objectValidator<ProviderStatus>({
  id: isProviderId,
  displayName: isString,
  installed: isBoolean,
  version: optional(isString),
  auth: enumValidator<ProviderStatus['auth']>({
    authenticated: true,
    unauthenticated: true,
    unknown: true,
  }),
  capabilities: optional(isCapabilities),
  setup: optional(isSetup),
  problem: optional(isString),
})
type Project = ResultOf<'projects.list'>['projects'][number]
const isSession = objectValidator<Project['sessions'][number]>({
  id: isString,
  title: isString,
  provider: isProviderId,
  agent: optional(isString),
  createdAt: isFiniteNumber,
  running: isBoolean,
  pinned: optional(isBoolean),
  status: optional(isInboxStatus),
  unread: optional(isBoolean),
  lifecycle: optional(isLifecycle),
  closedAt: optional(isFiniteNumber),
  worktreeBranch: optional(isString),
})
const isProject = objectValidator<Project>({
  path: isString,
  name: isString,
  pinned: isBoolean,
  createdAt: isFiniteNumber,
  sessions: arrayOf(isSession),
})
const isProjectsList = objectValidator<ResultOf<'projects.list'>>({ projects: arrayOf(isProject) })
const isProvidersList = objectValidator<ResultOf<'providers.list'>>({
  providers: arrayOf(isProvider),
})

/** Validate the largest common response without making a second 10,000-row object graph. */
export function parseProjectsListResult(value: unknown): ResultOf<'projects.list'> | undefined {
  return isProjectsList(value) ? value : undefined
}
export function parseProvidersListResult(value: unknown): ResultOf<'providers.list'> | undefined {
  return isProvidersList(value) ? value : undefined
}
function isUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}
