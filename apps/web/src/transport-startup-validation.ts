import type { MethodName, ProviderSetup, ResultOf } from '@harness/contracts'

/** Parse startup-critical replies without waiting for the full contract chunk. */
export function parseStartupMethodResult<M extends MethodName>(
  method: M,
  value: unknown,
): ResultOf<M> | undefined {
  if (method === 'projects.list') return parseProjectsListResult(value) as ResultOf<M> | undefined
  if (method === 'providers.list') return parseProvidersListResult(value) as ResultOf<M> | undefined
  return undefined
}

/** Validate the largest common response without making a second 10,000-row object graph. */
export function parseProjectsListResult(value: unknown): ResultOf<'projects.list'> | undefined {
  if (!isRecord(value) || !Array.isArray(value['projects'])) return undefined
  for (const project of value['projects']) {
    if (
      !isRecord(project) ||
      typeof project['path'] !== 'string' ||
      typeof project['name'] !== 'string' ||
      typeof project['pinned'] !== 'boolean' ||
      !isFiniteNumber(project['createdAt']) ||
      !Array.isArray(project['sessions'])
    ) {
      return undefined
    }
    for (const session of project['sessions']) {
      if (
        !isRecord(session) ||
        typeof session['id'] !== 'string' ||
        typeof session['title'] !== 'string' ||
        !isProviderId(session['provider']) ||
        !isOptionalString(session['agent']) ||
        !isFiniteNumber(session['createdAt']) ||
        typeof session['running'] !== 'boolean' ||
        !isOptionalBoolean(session['pinned']) ||
        !isOptionalInboxStatus(session['status']) ||
        !isOptionalBoolean(session['unread']) ||
        !isOptionalLifecycle(session['lifecycle']) ||
        !isOptionalFiniteNumber(session['closedAt']) ||
        !isOptionalString(session['worktreeBranch'])
      ) {
        return undefined
      }
    }
  }
  return value as ResultOf<'projects.list'>
}

export function parseProvidersListResult(value: unknown): ResultOf<'providers.list'> | undefined {
  if (!isRecord(value) || !Array.isArray(value['providers'])) return undefined
  for (const provider of value['providers']) {
    if (
      !isRecord(provider) ||
      !isProviderId(provider['id']) ||
      typeof provider['displayName'] !== 'string' ||
      typeof provider['installed'] !== 'boolean' ||
      !isOptionalString(provider['version']) ||
      (provider['auth'] !== 'authenticated' &&
        provider['auth'] !== 'unauthenticated' &&
        provider['auth'] !== 'unknown') ||
      !isOptionalCapabilities(provider['capabilities']) ||
      !isOptionalProviderSetup(provider['setup']) ||
      !isOptionalString(provider['problem'])
    ) {
      return undefined
    }
  }
  return value as ResultOf<'providers.list'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isProviderId(value: unknown): boolean {
  return (
    value === 'codex' ||
    value === 'claude-code' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'opencode' ||
    value === 'antigravity' ||
    value === 'pi' ||
    value === 'acp' ||
    value === 'api'
  )
}

function isOptionalInboxStatus(value: unknown): boolean {
  return (
    value === undefined ||
    value === 'starting' ||
    value === 'working' ||
    value === 'queued' ||
    value === 'approval' ||
    value === 'input' ||
    value === 'failed' ||
    value === 'ready' ||
    value === 'idle'
  )
}

function isOptionalLifecycle(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value['state'] === 'active') {
    return (
      typeof value['keepActive'] === 'boolean' &&
      (value['wokeAt'] === undefined || isNonnegativeInteger(value['wokeAt']))
    )
  }
  if (value['state'] === 'settled') {
    return (
      isNonnegativeInteger(value['settledAt']) &&
      (value['reason'] === 'manual' ||
        value['reason'] === 'inactivity' ||
        value['reason'] === 'change_request')
    )
  }
  return (
    value['state'] === 'snoozed' &&
    isNonnegativeInteger(value['snoozedAt']) &&
    isNonnegativeInteger(value['wakeAt'])
  )
}

function isOptionalCapabilities(value: unknown): boolean {
  if (value === undefined) return true
  return (
    isRecord(value) &&
    typeof value['steer'] === 'boolean' &&
    typeof value['fork'] === 'boolean' &&
    typeof value['interrupt'] === 'boolean' &&
    typeof value['reasoningItems'] === 'boolean' &&
    typeof value['approvals'] === 'boolean' &&
    isOptionalBoolean(value['userInput']) &&
    isOptionalBoolean(value['autoReview']) &&
    typeof value['images'] === 'boolean'
  )
}

const providerSetupFieldValidators = {
  installUrl: isUrl,
  installCommand: isOptionalString,
  login: (value: unknown) => value === 'app' || value === 'provider',
  loginOpensBrowser: isOptionalBoolean,
} satisfies {
  [Field in keyof ProviderSetup]-?: (value: unknown) => boolean
}

function isOptionalProviderSetup(value: unknown): boolean {
  if (value === undefined) return true
  return (
    isRecord(value) &&
    providerSetupFieldValidators.installUrl(value['installUrl']) &&
    providerSetupFieldValidators.installCommand(value['installCommand']) &&
    providerSetupFieldValidators.login(value['login']) &&
    providerSetupFieldValidators.loginOpensBrowser(value['loginOpensBrowser'])
  )
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

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
