import {
  GitHubRepositoryNameSchema,
  PULL_REQUEST_IMAGE_MAX_BYTES,
  PullRequestImageUrlSchema,
  type PullRequestImage,
} from '@harness/contracts'
import { z } from 'zod'
import type { GhRunner } from './pull-requests.js'

const CACHE_LIMIT = 64
const CACHE_BYTES = 32 * 1024 * 1024
const CONCURRENT_LOADS = 4
const CACHE_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 20_000
const UPLOAD_ID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const UPLOAD_PATH = new RegExp(
  `^/(?:user-attachments/assets|(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/)?assets/\\d+)/(${UPLOAD_ID})$`,
  'i',
)
const PRIVATE_UPLOAD_PATH = new RegExp(`^/\\d+/\\d+-(${UPLOAD_ID})\\.[a-z0-9]+$`, 'i')
const BlobSchema = z.object({
  size: z.number().int().positive().max(PULL_REQUEST_IMAGE_MAX_BYTES),
  encoding: z.string(),
  content: z.string().optional(),
  sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
})
const FileSchema = BlobSchema.extend({ type: z.literal('file') })

function imageTarget(source: string) {
  try {
    const url = new URL(PullRequestImageUrlSchema.parse(source))
    if (url.username || url.password || url.port) throw new Error()
    const upload =
      url.hostname === 'github.com'
        ? UPLOAD_PATH.exec(url.pathname)?.[1]
        : url.hostname === 'private-user-images.githubusercontent.com'
          ? PRIVATE_UPLOAD_PATH.exec(url.pathname)?.[1]
          : undefined
    if (upload) return { kind: 'upload' as const, id: upload.toLowerCase() }
    if (url.hostname === 'private-user-images.githubusercontent.com') throw new Error()
    const parts = url.pathname
      .slice(1)
      .split('/')
      .flatMap((part) => decodeURIComponent(part).split('/'))
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[/\\]/.test(part) ||
          [...part].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      )
    )
      throw new Error()
    const repository = GitHubRepositoryNameSchema.parse(parts.splice(0, 2).join('/'))
    if (url.hostname === 'github.com' && !['blob', 'raw'].includes(parts.shift() ?? '')) {
      throw new Error()
    }
    if (parts[0] === 'refs' && ['heads', 'tags'].includes(parts[1] ?? '')) parts.splice(0, 2)
    if (parts.length < 2) throw new Error()
    return { kind: 'repository' as const, repository, parts }
  } catch {
    throw new Error('Unsupported GitHub image URL')
  }
}

function imageBytes(raw: z.infer<typeof BlobSchema>): PullRequestImage {
  const data = raw.content?.replace(/\s/g, '') ?? ''
  if (
    raw.encoding !== 'base64' ||
    !data ||
    data.length > Math.ceil(PULL_REQUEST_IMAGE_MAX_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    throw new Error('Invalid image data')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length !== raw.size || bytes.toString('base64') !== data) {
    throw new Error('Invalid image size')
  }
  return checkedImage(bytes)
}

function checkedImage(bytes: Buffer): PullRequestImage {
  if (!bytes.length || bytes.length > PULL_REQUEST_IMAGE_MAX_BYTES)
    throw new Error('Invalid image size')
  const hex = bytes.subarray(0, 12).toString('hex')
  let mediaType: PullRequestImage['mediaType']
  if (hex.startsWith('89504e470d0a1a0a')) mediaType = 'image/png'
  else if (hex.startsWith('ffd8ff')) mediaType = 'image/jpeg'
  else if (/^474946383[79]61/.test(hex)) mediaType = 'image/gif'
  else if (hex.startsWith('52494646') && hex.endsWith('57454250')) mediaType = 'image/webp'
  else if (isAvif(bytes)) mediaType = 'image/avif'
  else if (hex.startsWith('424d')) mediaType = 'image/bmp'
  else if (hex.startsWith('00000100') || hex.startsWith('00000200')) mediaType = 'image/x-icon'
  else if (isSvg(bytes)) mediaType = 'image/svg+xml'
  else throw new Error('Unsupported image format')
  return { mediaType, data: bytes.toString('base64') }
}

function isAvif(bytes: Buffer): boolean {
  if (bytes.toString('ascii', 4, 8) !== 'ftyp') return false
  const boxEnd = Math.min(bytes.readUInt32BE(0), bytes.length, 256)
  for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
    if (offset === 12) continue
    if (['avif', 'avis'].includes(bytes.toString('ascii', offset, offset + 4))) return true
  }
  return false
}

function isSvg(bytes: Buffer): boolean {
  const opening = bytes
    .subarray(0, 4096)
    .toString('utf8')
    .trimStart()
    .replace(/^(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE svg[^>]*>\s*)+/i, '')
  // These bytes are displayed only as an img resource, never injected into the
  // document. Chromium's SVG image mode disables scripts and external resources.
  return /^<svg(?:\s|\/?>)/i.test(opening)
}

export class PullRequestImageService {
  readonly #cache = new Map<string, { image: PullRequestImage; expiresAt: number }>()
  readonly #pending = new Map<string, Promise<PullRequestImage>>()
  readonly #queue: (() => void)[] = []
  #active = 0
  #cacheBytes = 0

  constructor(
    private readonly run: GhRunner,
    private readonly now: () => number = Date.now,
  ) {}

  async image(source: string): Promise<PullRequestImage> {
    const target = imageTarget(source)
    const key = JSON.stringify(target)
    for (const [cachedKey, entry] of this.#cache) {
      if (entry.expiresAt <= this.now()) this.#evict(cachedKey)
    }
    const cached = this.#cache.get(key)
    if (cached) {
      this.#cache.delete(key)
      this.#cache.set(key, cached)
      return cached.image
    }
    const existing = this.#pending.get(key)
    if (existing) return existing
    if (this.#pending.size >= CACHE_LIMIT) throw new Error('Too many image requests')
    const deadline = this.now() + TIMEOUT_MS
    const pending = this.#schedule(() => this.#load(target, deadline))
      .then((image) => {
        this.#cache.set(key, { image, expiresAt: this.now() + CACHE_TTL_MS })
        this.#cacheBytes += image.data.length * 2
        while (this.#cache.size > CACHE_LIMIT || this.#cacheBytes > CACHE_BYTES) {
          const oldest = this.#cache.keys().next().value
          if (oldest !== undefined) this.#evict(oldest)
        }
        return image
      })
      // CLI diagnostics and API response headers never cross into the renderer.
      .catch(() => {
        throw new Error('Could not load this GitHub image')
      })
      .finally(() => this.#pending.delete(key))
    this.#pending.set(key, pending)
    return pending
  }

  #evict(key: string): void {
    const entry = this.#cache.get(key)
    if (entry) this.#cacheBytes -= entry.image.data.length * 2
    this.#cache.delete(key)
  }

  async #schedule(load: () => Promise<PullRequestImage>): Promise<PullRequestImage> {
    if (this.#active < CONCURRENT_LOADS) this.#active++
    else await new Promise<void>((resolve) => this.#queue.push(resolve))
    try {
      return await load()
    } finally {
      const next = this.#queue.shift()
      if (next) next()
      else this.#active--
    }
  }

  async #load(target: ReturnType<typeof imageTarget>, deadline: number): Promise<PullRequestImage> {
    if (deadline <= this.now()) throw new Error('Image request timed out')
    if (target.kind === 'upload') {
      const data = await this.run(
        [
          'api',
          '--hostname',
          'github.com',
          '--method',
          'GET',
          `https://github.com/user-attachments/assets/${target.id}`,
        ],
        {
          maxBytes: PULL_REQUEST_IMAGE_MAX_BYTES,
          timeoutMs: deadline - this.now(),
          encoding: 'base64',
        },
      )
      return checkedImage(Buffer.from(data, 'base64'))
    }
    const { repository, parts } = target
    const api = async (endpoint: string): Promise<unknown> => {
      const timeoutMs = deadline - this.now()
      if (timeoutMs <= 0) throw new Error('Image request timed out')
      return JSON.parse(
        await this.run(
          [
            'api',
            '--hostname',
            'github.com',
            '--method',
            'GET',
            endpoint,
            '--header',
            'Accept: application/vnd.github.object+json',
          ],
          { maxBytes: 16 * 1024 * 1024, timeoutMs },
        ),
      )
    }
    // GitHub file URLs do not separate a slash-containing ref from the file path.
    for (let split = 1; split < parts.length && split <= 16; split++) {
      const ref = encodeURIComponent(parts.slice(0, split).join('/'))
      const path = parts.slice(split).map(encodeURIComponent).join('/')
      let response: unknown
      try {
        response = await api(`repos/${repository}/contents/${path}?ref=${ref}`)
      } catch (error) {
        if (error instanceof Error && error.message.includes('(HTTP 404)')) continue
        throw error
      }
      const file = FileSchema.parse(response)
      if (file.encoding === 'base64') return imageBytes(file)
      // Contents omits base64 above 1 MiB. A fixed blob endpoint avoids signed
      // download URLs and keeps the existing CLI process boundary binary-safe.
      if (file.encoding !== 'none' || !file.sha) throw new Error('Missing image bytes')
      const blob = BlobSchema.parse(await api(`repos/${repository}/git/blobs/${file.sha}`))
      return imageBytes(blob)
    }
    throw new Error('Image not found')
  }
}
