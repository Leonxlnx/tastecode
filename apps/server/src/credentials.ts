import { Entry } from '@napi-rs/keyring'

const SERVICE = 'PersonalHarness'

export function readCredential(reference: string): string {
  try {
    const value = new Entry(SERVICE, reference).getPassword()
    if (value !== null) return value
  } catch {
    // The actionable error below deliberately excludes native error text,
    // which can contain credential metadata on some platforms.
  }
  throw new Error(`credential "${reference}" was not found in the OS credential store`)
}

export function hasCredential(reference: string): boolean {
  try {
    return new Entry(SERVICE, reference).getPassword() !== null
  } catch {
    return false
  }
}

export function writeCredential(reference: string, value: string): void {
  new Entry(SERVICE, reference).setPassword(value)
}

export function removeCredential(reference: string): void {
  try {
    new Entry(SERVICE, reference).deletePassword()
  } catch {
    // Removing an already absent credential is idempotent.
  }
}
