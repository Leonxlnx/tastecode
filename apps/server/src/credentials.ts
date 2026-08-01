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
