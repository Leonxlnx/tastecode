import { createRequire } from 'node:module'
import type { Entry as KeyringEntry } from '@napi-rs/keyring'

const SERVICE = 'PersonalHarness'
const require = createRequire(import.meta.url)
type EntryConstructor = typeof KeyringEntry
let loadedEntry: EntryConstructor | undefined

function entry(reference: string): KeyringEntry {
  loadedEntry ??= (require('@napi-rs/keyring') as { Entry: EntryConstructor }).Entry
  return new loadedEntry(SERVICE, reference)
}

export function readCredential(reference: string): string {
  try {
    const value = entry(reference).getPassword()
    if (value !== null) return value
  } catch {
    throw new Error(
      `credential "${reference}" could not be read from the OS credential store; unlock the store and try again`,
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
  try {
    entry(reference).setPassword(value)
  } catch {
    throw new Error(
      `credential "${reference}" could not be written to the OS credential store; unlock the store and try again`,
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

/** Delete a credential without reporting an unavailable keyring as success. */
export function removeCredentialStrict(reference: string): void {
  try {
    entry(reference).deleteCredential()
  } catch {
    throw new Error(
      `credential "${reference}" could not be removed from the OS credential store; unlock the store and try again`,
    )
  }
}
