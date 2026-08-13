import { randomBytes } from 'node:crypto'
import { hasCredential, readCredential, removeCredential, writeCredential } from './credentials.js'

/**
 * The long-lived token that authenticates the full web app on a phone
 * (`http://<address>:<port>/#access_token=<this>`). It grants full admin
 * access, so it lives in the OS credential store rather than in memory or in
 * the database (the DB holds no credentials by policy). The user bookmarks
 * the URL once and it keeps working across restarts.
 */
const WEB_REFERENCE = 'mobile-web-token'

export function loadOrCreateWebClientToken(): string {
  return loadOrCreateStableToken(WEB_REFERENCE)
}

function loadOrCreateStableToken(reference: string): string {
  try {
    return readCredential(reference)
  } catch {
    // First run, or the credential was removed — create one below.
  }
  const token = randomBytes(32).toString('base64url')
  try {
    writeCredential(reference, token)
  } catch {
    // No keychain (unusual for the desktop hosts). The surface is simply not
    // offered; the caller logs the degradation.
    return ''
  }
  return token
}

/** Testing and reset support: forget a stored token so a new one is minted. */
export function clearWebClientToken(): void {
  clearStableToken(WEB_REFERENCE)
}

function clearStableToken(reference: string): void {
  if (hasCredential(reference)) removeCredential(reference)
}
