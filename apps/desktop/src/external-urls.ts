const SUPPORTED_EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:'])

function externalUrlScheme(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).protocol
  } catch {
    return undefined
  }
}

/** Only http(s) URLs may be handed to the OS browser. Everything else —
 *  file:, javascript:, data:, custom schemes — stays on the deny path. */
export function isSupportedExternalUrl(value: unknown): boolean {
  return SUPPORTED_EXTERNAL_URL_PROTOCOLS.has(externalUrlScheme(value) ?? '')
}

/** Throwing variant for IPC handlers. Names the rejected scheme so the
 *  renderer error says what was refused and what is allowed. */
export function assertSupportedExternalUrl(value: unknown): string {
  if (typeof value === 'string' && isSupportedExternalUrl(value)) return value
  const scheme = externalUrlScheme(value)
  if (scheme) {
    throw new Error(
      `Refusing to open a ${scheme} link in the system browser: only http(s) links can be opened externally.`,
    )
  }
  throw new Error(
    'Refusing to open the link in the system browser: only http(s) links can be opened externally.',
  )
}
