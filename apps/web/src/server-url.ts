export function serverUrl(baseUrl: string, hash = globalThis.location?.hash ?? ''): string {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('access_token')
  if (!token) return baseUrl

  const url = new URL(baseUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

/**
 * Where the renderer finds the core server.
 *
 * - An explicit VITE_HARNESS_SERVER_URL (the dev:mobile flow) always wins.
 * - On loopback — the desktop app (file://) and the local dev server — the
 *   core server is ws://127.0.0.1:4311.
 * - Anywhere else the page was served by the server's own mobile listener
 *   (a phone opening http://<address>:4312/), so the socket lives on the
 *   same host and port as the page: ws://<address>:4312/ws.
 */
export function serverBaseUrl(envUrl: string | undefined): string {
  if (envUrl) return envUrl
  const host = globalThis.location?.hostname ?? ''
  const loopback =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    (host.length > 0 && host.startsWith('127.'))
  if (!host || loopback) return 'ws://127.0.0.1:4311'
  return `ws://${globalThis.location.host}/ws`
}
