import type { ProviderId } from '@harness/contracts'

/**
 * Providers whose last account read, in this run or an earlier one, said
 * signed in. The composer re-reads the account whenever it switches to a
 * provider, and that read starts the provider's CLI: about 2 s for Codex on a
 * busy machine, during which Send stayed off. A provider remembered here
 * keeps Send available while it reads; a read that answers signed out turns
 * it off again, and a CLI that really is signed out says so in the turn.
 *
 * Only whether a read said signed in is kept, never who.
 */
export const SIGNED_IN_PROVIDERS_KEY = 'harness.signedInProviders'

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(SIGNED_IN_PROVIDERS_KEY)
    const value: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

export function rememberedSignIn(provider: ProviderId): boolean {
  return read().has(provider)
}

/** Record what an account read of `provider` answered. */
export function rememberSignIn(provider: ProviderId, signedIn: boolean): void {
  const providers = read()
  if (providers.has(provider) === signedIn) return
  if (signedIn) providers.add(provider)
  else providers.delete(provider)
  try {
    localStorage.setItem(SIGNED_IN_PROVIDERS_KEY, JSON.stringify([...providers]))
  } catch {
    // Without storage the composer waits for each read, as before.
  }
}
