import type { ProviderStatus } from '@harness/contracts'

/**
 * Whether a provider is signed in as far as the app knows: the last account
 * read it kept, else the install-time check the provider scan ran where the
 * CLI has one. Undefined when neither answered.
 *
 * `lastSignIn` must be undefined when new chats start on an account that the
 * kept read did not ask about.
 */
export function knownSignIn(
  status: ProviderStatus,
  lastSignIn: boolean | undefined,
): boolean | undefined {
  if (lastSignIn !== undefined) return lastSignIn
  return status.auth === 'unknown' ? undefined : status.auth === 'authenticated'
}

/**
 * Whether a provider's own models can run now, from what the app already
 * knows: the provider scan (installed, the capabilities it declares) and its
 * sign-in (`knownSignIn`). A provider the scan has not reported yet, or whose
 * sign-in nothing has answered, is not ruled out.
 */
export function providerCanRun(
  status: ProviderStatus | undefined,
  lastSignIn: boolean | undefined,
): boolean {
  if (!status) return true
  if (!status.installed || !status.capabilities) return false
  return knownSignIn(status, lastSignIn) !== false
}
