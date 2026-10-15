export type BrowserAddress = { url: string; error?: undefined } | { url?: undefined; error: string }

export const PLAIN_HTTP_LOOPBACK_ONLY =
  'Plain HTTP only works for localhost and 127.0.0.1. Use https:// for other sites.'

/**
 * Turn what the user typed into the URL the guest loads, under the rule the
 * desktop shell enforces (embedded-browser.ts): HTTPS anywhere, plain HTTP only
 * on loopback. An address the shell would cancel is refused here with the
 * reason, instead of failing later with a raw Chromium code.
 */
export function browserAddress(value: string): BrowserAddress {
  const trimmed = value.trim()
  if (!trimmed) return { error: 'Enter a URL.' }
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
  // There is no search to fall back to, so a schemeless entry with spaces is not an address.
  if (!hasScheme && /\s/.test(trimmed)) return { error: 'Enter a valid URL.' }
  let url = parseUrl(hasScheme ? trimmed : `http://${trimmed}`)
  if (!url) return { error: 'Enter a valid URL.' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Enter a valid HTTP or HTTPS URL.' }
  }
  if (!hasScheme && !isLoopbackHostname(url.hostname)) {
    // A bare IP address is a LAN dev server or device, which speak plain HTTP; a name is a site.
    if (isIpAddress(url.hostname)) return { error: PLAIN_HTTP_LOOPBACK_ONLY }
    url = parseUrl(`https://${trimmed}`)
    if (!url) return { error: 'Enter a valid URL.' }
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    return { error: PLAIN_HTTP_LOOPBACK_ONLY }
  }
  // 0.0.0.0 is a listen address Chromium refuses to connect to, and plain-HTTP localhost can
  // resolve to IPv6 first while dev servers bind 127.0.0.1.
  if (
    url.hostname === '0.0.0.0' ||
    (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '[::1]'))
  ) {
    url.hostname = '127.0.0.1'
  }
  return { url: url.href }
}

/** isLoopbackHostname in apps/desktop/src/embedded-browser.ts, plus 0.0.0.0, mapped above. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === '[::1]' || hostname === '0.0.0.0') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true
  const domain = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  return domain === 'localhost' || domain.endsWith('.localhost')
}

function isIpAddress(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}
