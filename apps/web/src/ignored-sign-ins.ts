import { useSyncExternalStore } from 'react'
import type { DetectedAccountHome } from '@harness/contracts'

/**
 * Sign-ins found on the computer that the user asked not to be offered
 * again. They leave Found on this computer and the count beside the
 * Providers plus, and wait under Ignored until taken back. Kept per profile;
 * a folder found again later stays ignored.
 */
const IGNORED_KEY = 'harness.ignoredSignIns.v1'

const listeners = new Set<() => void>()
let cachedRaw: string | null = null
let cached: readonly string[] = []

/** One found folder, as the ignore list keys it: provider ids hold no spaces. */
export function signInKey(entry: Pick<DetectedAccountHome, 'provider' | 'home'>): string {
  return `${entry.provider} ${entry.home}`
}

/** The same list for as long as storage holds the same text, as useSyncExternalStore needs. */
function read(): readonly string[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(IGNORED_KEY)
  } catch {
    return cached
  }
  if (raw === cachedRaw) return cached
  cachedRaw = raw
  try {
    const stored: unknown = JSON.parse(raw ?? '[]')
    cached = Array.isArray(stored)
      ? stored.filter((key): key is string => typeof key === 'string')
      : []
  } catch {
    cached = []
  }
  return cached
}

function write(keys: readonly string[]): void {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify(keys))
  } catch {
    // The choice still holds until the app restarts when storage is full or blocked.
    cachedRaw = JSON.stringify(keys)
    cached = keys
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function ignoreSignIn(entry: Pick<DetectedAccountHome, 'provider' | 'home'>): void {
  const key = signInKey(entry)
  const keys = read()
  if (!keys.includes(key)) write([...keys, key])
}

export function unignoreSignIn(entry: Pick<DetectedAccountHome, 'provider' | 'home'>): void {
  const key = signInKey(entry)
  write(read().filter((each) => each !== key))
}

/** The ignored sign-ins' keys, current across every view that shows found sign-ins. */
export function useIgnoredSignIns(): readonly string[] {
  return useSyncExternalStore(subscribe, read, read)
}
