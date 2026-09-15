import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '../../transport.js'
import { PullRequestImageCache, pullRequestImageUrl } from './pull-request-image-source.js'

describe('pull-request image URL resolution', () => {
  it.each(['docs/before.png', './docs/before.png', '/docs/before.png', '../docs/before.png'])(
    'resolves %s against the PR head without touching local files',
    (source) =>
      expect(pullRequestImageUrl(source, 'owner/repo', 'abc')).toBe(
        'https://github.com/owner/repo/blob/abc/docs/before.png',
      ),
  )
  it('encodes slash-containing refs and preserves encoded filenames', () => {
    expect(pullRequestImageUrl('docs/a%20b.svg', 'owner/repo', 'design/images')).toBe(
      'https://github.com/owner/repo/blob/design%2Fimages/docs/a%20b.svg',
    )
  })
  it('does not leak signed upload parameters into the RPC or cache keys', () => {
    expect(
      pullRequestImageUrl(
        'https://private-user-images.githubusercontent.com/123/image.png?jwt=expired#fragment',
      ),
    ).toBe('https://private-user-images.githubusercontent.com/123/image.png')
  })
  it('supports GitHub-root and protocol-relative image references', () => {
    expect(pullRequestImageUrl('/user-attachments/assets/example')).toBe(
      'https://github.com/user-attachments/assets/example',
    )
    expect(pullRequestImageUrl('//user-images.githubusercontent.com/image.png')).toBe(
      'https://user-images.githubusercontent.com/image.png',
    )
    expect(pullRequestImageUrl('/owner/repo/blob/main/docs/a.png', 'another/repo', 'def')).toBe(
      'https://github.com/owner/repo/blob/main/docs/a.png',
    )
  })
})

describe('renderer image cache', () => {
  const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
  it('deduplicates pending requests and serves repeat views without any RPC', async () => {
    let now = 0
    const request = vi.fn().mockResolvedValue(image)
    const cache = new PullRequestImageCache({ request } as unknown as Transport, () => now)
    const urls = Array.from(
      { length: 30 },
      (_, index) => `https://github.com/owner/repo/blob/main/${index}.png`,
    )
    await Promise.all(urls.flatMap((url) => [cache.load(url), cache.load(url)]))
    expect(request).toHaveBeenCalledTimes(30)
    for (let pass = 0; pass < 10; pass++) await Promise.all(urls.map((url) => cache.load(url)))
    expect(request).toHaveBeenCalledTimes(30)
    now = 300_001
    await cache.load(urls[0]!)
    expect(request).toHaveBeenCalledTimes(31)
  })
  it('bounds retained bytes and does not pin failed image requests', async () => {
    const request = vi.fn().mockResolvedValue({ ...image, data: 'A'.repeat(9 * 1024 * 1024) })
    const cache = new PullRequestImageCache({ request } as unknown as Transport)
    await cache.load('https://github.com/owner/repo/blob/main/a.png')
    await cache.load('https://github.com/owner/repo/blob/main/b.png')
    await cache.load('https://github.com/owner/repo/blob/main/a.png')
    expect(request).toHaveBeenCalledTimes(3)
    const url = 'https://github.com/owner/repo/blob/main/c.png'
    request.mockRejectedValueOnce(new Error('Unavailable'))
    expect(await cache.load(url)).toBe(`${url}?raw=true`)
    request.mockResolvedValueOnce(image)
    expect(await cache.load(url)).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})
