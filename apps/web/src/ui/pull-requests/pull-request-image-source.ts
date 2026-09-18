import type { Transport } from '../../transport.js'

const CACHE_TTL_MS = 5 * 60_000
const CACHE_BYTES = 32 * 1024 * 1024
const caches = new WeakMap<Transport, PullRequestImageCache>()

function directImageUrl(source: string): string {
  const url = new URL(source)
  if (url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/(?:blob|raw)\//.test(url.pathname)) {
    url.searchParams.set('raw', 'true')
  }
  return url.href
}

export function pullRequestImageUrl(source: string, repository?: string, ref?: string): string {
  let url: URL
  try {
    if (source.startsWith('//')) source = `https:${source}`
    if (
      /^\/(?:user-attachments\/|(?:[^/]+\/[^/]+\/)?assets\/|[^/]+\/[^/]+\/(?:blob|raw)\/)/.test(
        source,
      )
    ) {
      source = `https://github.com${source}`
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(source) && repository && ref) {
      const parts: string[] = []
      for (const part of source.split('/')) {
        if (part === '..') parts.pop()
        else if (part && part !== '.') parts.push(part)
      }
      source = `https://github.com/${repository}/blob/${encodeURIComponent(ref)}/${parts.join('/')}`
    }
    url = new URL(source)
    if (url.protocol !== 'https:' || url.username || url.password) return source
    if (
      [
        'github.com',
        'raw.githubusercontent.com',
        'private-user-images.githubusercontent.com',
      ].includes(url.hostname)
    ) {
      url.search = ''
      url.hash = ''
    }
    return url.href
  } catch {
    return source
  }
}

export function resolvePullRequestImage(transport: Transport, source: string): Promise<string> {
  const authenticatedImage =
    /^https:\/\/(?:github\.com\/(?:user-attachments\/assets\/|(?:[^/]+\/[^/]+\/)?assets\/|[^/]+\/[^/]+\/(?:blob|raw)\/)|(?:raw|private-user-images)\.githubusercontent\.com\/)/.test(
      source,
    )
  if (!authenticatedImage) return Promise.resolve(source)
  let cache = caches.get(transport)
  if (!cache) {
    cache = new PullRequestImageCache(transport)
    caches.set(transport, cache)
  }
  return cache.load(source)
}

/** Share bytes across repeated images, tab changes, and PR descriptions/reviews. */
export class PullRequestImageCache {
  readonly #cache = new Map<string, { source: string; expiresAt: number }>()
  readonly #pending = new Map<string, Promise<string>>()
  #bytes = 0

  constructor(
    private readonly transport: Transport,
    private readonly now = Date.now,
  ) {}

  load(url: string): Promise<string> {
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= this.now()) this.#evict(key)
    }
    const cached = this.#cache.get(url)
    if (cached) {
      this.#cache.delete(url)
      this.#cache.set(url, cached)
      return Promise.resolve(cached.source)
    }
    const existing = this.#pending.get(url)
    if (existing) return existing
    const pending = this.transport
      .request('pullRequests.image', { url })
      .then((image) => {
        const source = `data:${image.mediaType};base64,${image.data}`
        this.#cache.set(url, { source, expiresAt: this.now() + CACHE_TTL_MS })
        this.#bytes += source.length * 2
        while (this.#cache.size > 64 || this.#bytes > CACHE_BYTES) {
          const oldest = this.#cache.keys().next().value
          if (oldest !== undefined) this.#evict(oldest)
        }
        return source
      })
      // Public URLs remain usable with an older server or a signed-out CLI.
      .catch(() => directImageUrl(url))
      .finally(() => this.#pending.delete(url))
    this.#pending.set(url, pending)
    return pending
  }

  #evict(key: string): void {
    const entry = this.#cache.get(key)
    if (entry) this.#bytes -= entry.source.length * 2
    this.#cache.delete(key)
  }
}
