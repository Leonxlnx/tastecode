import type { Transport } from '../transport.js'

const CACHE_BYTES = 64 * 1024 * 1024
const caches = new WeakMap<Transport, ChatImageCache>()

/**
 * A Markdown image source as a path on the computer the chat runs on, or
 * nothing for a web address: `/tmp/shot.png`, `C:\Shots\a.png` or a `file:`
 * URL. The server compares paths however they are spelled.
 */
export function localImagePath(source: string): string | undefined {
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source)
      if (url.host && url.host !== 'localhost') return undefined
      const file = decodeURIComponent(url.pathname)
      // file:///C:/Shots/a.png names C:/Shots/a.png.
      return /^\/[a-z]:\//i.test(file) ? file.slice(1) : file
    } catch {
      return undefined
    }
  }
  let decoded = source
  try {
    decoded = decodeURIComponent(source)
  } catch {
    // A stray % in a real file name: the source is the path as written.
  }
  if (decoded.startsWith('//')) return undefined
  return decoded.startsWith('/') || /^[a-z]:[\\/]/i.test(decoded) ? decoded : undefined
}

/**
 * What an image in a chat's reply loads from. A picture on the computer comes
 * through the server, which hands out only those the chat's replies show; the
 * renderer cannot read the disk, and its own origin has no such file.
 */
export function resolveChatImage(
  transport: Transport,
  threadId: string,
  source: string,
): Promise<string> {
  const file = localImagePath(source)
  if (!file) return Promise.resolve(source)
  let cache = caches.get(transport)
  if (!cache) {
    cache = new ChatImageCache(transport)
    caches.set(transport, cache)
  }
  return cache.load(threadId, file)
}

/** Keeps the pictures a chat shows while it scrolls, remounts and reopens. */
export class ChatImageCache {
  readonly #cache = new Map<string, string>()
  readonly #pending = new Map<string, Promise<string>>()
  #bytes = 0

  constructor(private readonly transport: Transport) {}

  load(threadId: string, file: string): Promise<string> {
    const key = `${threadId}\n${file}`
    const cached = this.#cache.get(key)
    if (cached) {
      this.#cache.delete(key)
      this.#cache.set(key, cached)
      return Promise.resolve(cached)
    }
    const existing = this.#pending.get(key)
    if (existing) return existing
    const pending = this.transport
      .request('attachments.read', { threadId, path: file })
      .then((image) => {
        const source = `data:${image.mimeType};base64,${image.data}`
        this.#cache.set(key, source)
        this.#bytes += source.length * 2
        while (this.#bytes > CACHE_BYTES && this.#cache.size > 1) {
          const oldest = this.#cache.keys().next().value
          if (oldest === undefined) break
          this.#bytes -= (this.#cache.get(oldest)?.length ?? 0) * 2
          this.#cache.delete(oldest)
        }
        return source
      })
      .finally(() => this.#pending.delete(key))
    this.#pending.set(key, pending)
    return pending
  }
}
