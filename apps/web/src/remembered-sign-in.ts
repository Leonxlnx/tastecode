import type { ProviderId } from '@harness/contracts'

/**
 * What the last account read of each provider said, in this run or an earlier
 * one. The composer re-reads the account whenever it switches to a provider,
 * and that read starts the provider's CLI: about 2 s for Codex on a busy
 * machine, during which Send stayed off. A provider remembered as signed in
 * keeps Send available while it reads; a read that answers signed out turns it
 * off again, and a CLI that really is signed out says so in the turn. A
 * provider remembered as signed out is not offered in the model picker until a
 * read says otherwise.
 *
 * Only whether a read said signed in or signed out is kept, never who.
 */
export const SIGNED_IN_PROVIDERS_KEY = 'harness.signedInProviders'
export const SIGNED_OUT_PROVIDERS_KEY = 'harness.signedOutProviders'

function read(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    const value: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

function write(key: string, providers: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...providers]))
  } catch {
    // Without storage the composer waits for each read, as before.
  }
}

const listeners = new Set<() => void>()
let version = 0

export function rememberedSignIn(provider: ProviderId): boolean {
  return read(SIGNED_IN_PROVIDERS_KEY).has(provider)
}

/** True or false as the last kept read said; undefined when none was kept. */
export function lastSignIn(provider: ProviderId): boolean | undefined {
  if (read(SIGNED_IN_PROVIDERS_KEY).has(provider)) return true
  if (read(SIGNED_OUT_PROVIDERS_KEY).has(provider)) return false
  return undefined
}

/** Record what an account read of `provider` answered. */
export function rememberSignIn(provider: ProviderId, signedIn: boolean): void {
  const signedInProviders = read(SIGNED_IN_PROVIDERS_KEY)
  const signedOutProviders = read(SIGNED_OUT_PROVIDERS_KEY)
  if (signedInProviders.has(provider) === signedIn && signedOutProviders.has(provider) !== signedIn)
    return
  if (signedIn) {
    signedInProviders.add(provider)
    signedOutProviders.delete(provider)
  } else {
    signedInProviders.delete(provider)
    signedOutProviders.add(provider)
  }
  write(SIGNED_IN_PROVIDERS_KEY, signedInProviders)
  write(SIGNED_OUT_PROVIDERS_KEY, signedOutProviders)
  version += 1
  for (const listener of listeners) listener()
}

/** For useSyncExternalStore: changes whenever a kept answer changes in this window. */
export function rememberedSignInsVersion(): number {
  return version
}

export function subscribeRememberedSignIns(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
