import { createRequire } from 'node:module'
import type { Entry as KeyringEntry } from '@napi-rs/keyring'
import { isAsarRuntime, rethrowNativeBindingFailure } from './native-binding-error.js'

const SERVICE = 'PersonalHarness'

// On Linux there may be no Secret Service provider at all (headless DE,
// minimal install), which looks identical to a locked store — the advice has
// to cover both.
const STORE_HINT =
  process.platform === 'linux'
    ? 'unlock the store or install a Secret Service provider (gnome-keyring, KWallet) and try again'
    : 'unlock the store and try again'
const require = createRequire(import.meta.url)
type EntryConstructor = typeof KeyringEntry
let loadedEntry: EntryConstructor | undefined

/**
 * The binding load sits outside every store-operation try below on purpose:
 * a keyring.node removed or replaced under a running packaged install is not
 * a locked/absent Secret Service, and the STORE_HINT advice would send the
 * user after a store that is healthy.
 */
function loadEntry(): EntryConstructor {
  if (loadedEntry) return loadedEntry
  try {
    loadedEntry = (require('@napi-rs/keyring') as { Entry: EntryConstructor }).Entry
    return loadedEntry
  } catch (error) {
    rethrowNativeBindingFailure(
      error,
      'the OS credential store binding',
      isAsarRuntime(import.meta.url),
    )
  }
}

function entry(reference: string): KeyringEntry {
  return new (loadEntry())(SERVICE, reference)
}

export function readCredential(reference: string): string {
  const Entry = loadEntry()
  try {
    const value = new Entry(SERVICE, reference).getPassword()
    if (value !== null) return value
  } catch {
    throw new Error(
      `credential "${reference}" could not be read from the OS credential store; ${STORE_HINT}`,
    )
  }
  throw new Error(`credential "${reference}" was not found in the OS credential store`)
}

export function hasCredential(reference: string): boolean {
  try {
    return entry(reference).getPassword() !== null
  } catch {
    return false
  }
}

export function writeCredential(reference: string, value: string): void {
  const Entry = loadEntry()
  try {
    new Entry(SERVICE, reference).setPassword(value)
  } catch {
    throw new Error(
      `credential "${reference}" could not be written to the OS credential store; ${STORE_HINT}`,
    )
  }
}

export function removeCredential(reference: string): void {
  try {
    entry(reference).deleteCredential()
  } catch {
    // Existing callers use best-effort cleanup. Security-sensitive migrations
    // use removeCredentialStrict so an unavailable store remains retryable.
  }
}

/**
 * Delete a credential without reporting an unavailable keyring as success.
 * `@napi-rs/keyring` collapses delete errors into `false` instead of throwing,
 * so a failed delete is only acceptable once the credential proves absent.
 */
export function removeCredentialStrict(reference: string): void {
  const Entry = loadEntry()
  try {
    if (new Entry(SERVICE, reference).deleteCredential()) return
  } catch {
    // fall through to the presence check
  }
  try {
    if (new Entry(SERVICE, reference).getPassword() === null) return
  } catch {
    // store error: cannot confirm removal
  }
  throw new Error(
    `credential "${reference}" could not be removed from the OS credential store; ${STORE_HINT}`,
  )
}
