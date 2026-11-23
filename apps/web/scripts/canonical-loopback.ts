/**
 * Redirects non-canonical loopback browser requests (`localhost` / `[::1]`)
 * onto the canonical `127.0.0.1` dev origin.
 *
 * The core server's WebSocket origin gate strictly admits only the configured
 * `127.0.0.1` renderer origin, whereas macOS resolves `localhost` to
 * `127.0.0.1` and lets Vite serve the page on `http://localhost:<port>` before
 * every socket upgrade is rejected with `1008 Origin not allowed`.
 */
export function canonicalLoopbackRedirect(
  method: string | undefined,
  host: string | undefined,
  url: string | undefined,
  port: number,
): string | undefined {
  if (method !== 'GET' && method !== 'HEAD') return undefined
  const normalizedHost = host?.trim().toLowerCase()
  if (normalizedHost !== `localhost:${port}` && normalizedHost !== `[::1]:${port}`) {
    return undefined
  }
  const raw = url ?? '/'
  const pathAndQuery = (raw.startsWith('/') ? raw : `/${raw}`).replace(/^\/+/, '/')
  return `http://127.0.0.1:${port}${pathAndQuery}`
}
