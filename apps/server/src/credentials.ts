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
    // The actionable error below deliberately excludes native error text,
    // which can contain credential metadata on some platforms.
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
  entry(reference).setPassword(value)
}

export function removeCredential(reference: string): void {
  try {
    entry(reference).deletePassword()
  } catch {
    // Removing an already absent credential is idempotent.
  }
}
