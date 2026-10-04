import { describe, expect, it, vi } from 'vitest'
import type { GhRunner } from './pull-requests.js'
import { PullRequestImageService } from './pull-request-images.js'

const url = 'https://github.com/owner/repo/blob/abc/docs/before.png?raw=true'
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const file = (bytes = png) =>
  JSON.stringify({
    type: 'file',
    size: bytes.length,
    sha: 'a'.repeat(40),
    encoding: 'base64',
    content: `${bytes.toString('base64')}\n`,
  })

describe('authenticated pull-request images', () => {
  it.each([
    ['ffd8ff000000000000000000', 'image/jpeg'],
    ['474946383761000000000000', 'image/gif'],
    ['474946383961000000000000', 'image/gif'],
    ['524946460000000057454250', 'image/webp'],
    ['000000206674797061766966', 'image/avif'],
    ['000000206674797061766973', 'image/avif'],
    ['424d00000000000000000000', 'image/bmp'],
    ['000001000100000000000000', 'image/x-icon'],
  ])('detects %s by its bytes rather than the filename', async (hex, mediaType) => {
    const run = vi.fn<GhRunner>().mockResolvedValue(file(Buffer.from(hex, 'hex')))
    expect((await new PullRequestImageService(run).image(url)).mediaType).toBe(mediaType)
  })

  it('loads private image bytes through a fixed GitHub API endpoint', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValue(file())
    const service = new PullRequestImageService(run)
    expect(await service.image(url)).toEqual({
      mediaType: 'image/png',
      data: png.toString('base64'),
    })
    expect(run).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        'repos/owner/repo/contents/docs/before.png?ref=abc',
        '--header',
        'Accept: application/vnd.github.object+json',
      ],
      expect.objectContaining({ maxBytes: 16 * 1024 * 1024, timeoutMs: expect.any(Number) }),
    )
  })

  it.each([
    'https://raw.githubusercontent.com/owner/repo/main/docs/a%20b.png',
    'https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/a%20b.png',
    'https://github.com/owner/repo/raw/refs/heads/main/docs/a%20b.png',
  ])('handles raw file URLs: %s', async (source) => {
    const run = vi.fn<GhRunner>().mockResolvedValue(file())
    await new PullRequestImageService(run).image(source)
    expect(run.mock.calls[0]?.[0]).toContain('repos/owner/repo/contents/docs/a%20b.png?ref=main')
  })

  it.each(['design/images', 'design%2Fimages'])(
    'resolves ref %s only after a not-found response',
    async (ref) => {
      const run = vi
        .fn<GhRunner>()
        .mockRejectedValueOnce(new Error('gh: Not Found (HTTP 404)'))
        .mockResolvedValue(file())
      await new PullRequestImageService(run).image(
        `https://github.com/owner/repo/blob/${ref}/docs/before.png`,
      )
      expect(run.mock.calls[1]?.[0]).toContain(
        'repos/owner/repo/contents/docs/before.png?ref=design%2Fimages',
      )
    },
  )

  it('fetches large files by their validated blob SHA without following download URLs', async () => {
    const run = vi
      .fn<GhRunner>()
      .mockResolvedValueOnce(
        JSON.stringify({
          type: 'file',
          size: png.length,
          sha: 'a'.repeat(40),
          encoding: 'none',
          content: '',
          download_url: 'https://untrusted.example/image',
        }),
      )
      .mockResolvedValueOnce(file())
    const image = await new PullRequestImageService(run).image(url)
    expect(image.mediaType).toBe('image/png')
    expect(run.mock.calls[1]?.[0]).toContain(`repos/owner/repo/git/blobs/${'a'.repeat(40)}`)
  })

  it.each([
    'http://github.com/owner/repo/blob/main/a.png',
    'https://github.com.evil.test/owner/repo/blob/main/a.png',
    'https://github.com@evil.test/owner/repo/blob/main/a.png',
    'https://user:password@github.com/owner/repo/blob/main/a.png',
    'https://github.com:444/owner/repo/blob/main/a.png',
    'https://127.0.0.1/a.png',
    'file:///tmp/a.png',
    'https://github.com/user-attachments/assets/image',
    'https://github.com/owner/repo/issues/1',
    'https://github.com/owner/repo/blob/main/%2e%2e%2fa.png',
    'https://github.com/owner/repo/blob/main/%00.png',
    'https://github.com/owner/repo/blob/main/%zz.png',
  ])('rejects unsafe or unsupported targets before spawning gh: %s', async (source) => {
    const run = vi.fn<GhRunner>()
    await expect(new PullRequestImageService(run).image(source)).rejects.toThrow(
      'Unsupported GitHub image URL',
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    JSON.stringify({ type: 'dir', size: 1 }),
    JSON.stringify({ type: 'file', size: 11 * 1024 * 1024 }),
    file(Buffer.from('<html>not an image</html>')),
    JSON.stringify({ type: 'file', size: 1, encoding: 'base64', content: 'not base64!' }),
    JSON.stringify({ type: 'file', size: 1, encoding: 'none', sha: '../../other' }),
  ])('does not return invalid, oversized, or active content', async (response) => {
    const run = vi.fn<GhRunner>().mockResolvedValue(response)
    await expect(new PullRequestImageService(run).image(url)).rejects.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('deduplicates requests and expires its bounded cache', async () => {
    let now = 0
    const run = vi.fn<GhRunner>().mockResolvedValue(file())
    const service = new PullRequestImageService(run, () => now)
    await Promise.all([service.image(url), service.image(url)])
    await service.image(url)
    expect(run).toHaveBeenCalledTimes(1)
    now = 300_001
    await service.image(url)
    expect(run).toHaveBeenCalledTimes(2)
    for (let index = 0; index < 64; index++) await service.image(url.replace('before', `${index}`))
    await service.image(url)
    expect(run).toHaveBeenCalledTimes(67)
  })

  it('queues image-heavy PRs rather than rejecting the ninth image', async () => {
    let active = 0
    let peak = 0
    const run = vi.fn<GhRunner>(async () => {
      peak = Math.max(peak, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return file()
    })
    const service = new PullRequestImageService(run)
    const images = await Promise.all(
      Array.from({ length: 20 }, (_, index) => service.image(url.replace('before', `${index}`))),
    )
    expect(images).toHaveLength(20)
    expect(peak).toBe(4)
    expect(run).toHaveBeenCalledTimes(20)
  })

  it('bounds queued work and releases failed requests for retry', async () => {
    const run = vi
      .fn<GhRunner>()
      .mockImplementation(
        () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('CLI error')), 1)),
      )
    const service = new PullRequestImageService(run)
    const pending = Array.from({ length: 64 }, (_, index) =>
      service.image(url.replace('before', `${index}`)).catch(() => undefined),
    )
    await expect(service.image(url)).rejects.toThrow('Too many image requests')
    await Promise.all(pending)
    run.mockResolvedValue(file())
    expect((await service.image(url)).mediaType).toBe('image/png')
  })

  it('does not leak CLI output or retry authentication failures', async () => {
    const run = vi.fn<GhRunner>().mockRejectedValue(new Error('private diagnostic (HTTP 403)'))
    await expect(new PullRequestImageService(run).image(url)).rejects.toThrow(
      'Could not load this GitHub image',
    )
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('bounds ref resolution by both time and request count', async () => {
    let now = 0
    const run = vi.fn<GhRunner>(async () => {
      now += 20_001
      throw new Error('gh: Not Found (HTTP 404)')
    })
    const service = new PullRequestImageService(run, () => now)
    await expect(service.image(url)).rejects.toThrow('Could not load this GitHub image')
    expect(run).toHaveBeenCalledTimes(1)
    run.mockImplementation(async () => {
      throw new Error('gh: Not Found (HTTP 404)')
    })
    await expect(
      service.image(`https://github.com/owner/repo/blob/${'part/'.repeat(30)}image.png`),
    ).rejects.toThrow('Could not load this GitHub image')
    expect(run).toHaveBeenCalledTimes(17)
  })

  it('handles image bytes at the size limit without unbounded validation work', async () => {
    const bytes = Buffer.alloc(10 * 1024 * 1024)
    png.copy(bytes)
    const run = vi.fn<GhRunner>().mockResolvedValue(file(bytes))
    const result = await new PullRequestImageService(run).image(url)
    expect(result.data.length).toBe(Math.ceil(bytes.length / 3) * 4)
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    '<?xml version="1.0"?>\n<!-- diagram -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
  ])('returns SVG bytes for isolated img rendering, never inline HTML', async (svg) => {
    const run = vi.fn<GhRunner>().mockResolvedValue(file(Buffer.from(svg)))
    const image = await new PullRequestImageService(run).image(url.replace('.png', '.svg'))
    expect(image.mediaType).toBe('image/svg+xml')
    expect(Buffer.from(image.data, 'base64').toString()).toBe(svg)
  })

  it.each([
    'https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc',
    'https://github.com/assets/12345/12345678-1234-1234-1234-123456789abc',
    'https://private-user-images.githubusercontent.com/12345/67890-12345678-1234-1234-1234-123456789abc.png?jwt=expired',
  ])('authenticates uploads without persisting signed URLs: %s', async (source) => {
    const run = vi.fn<GhRunner>().mockResolvedValue(png.toString('base64'))
    const result = await new PullRequestImageService(run).image(source)
    expect(result.mediaType).toBe('image/png')
    expect(run.mock.calls[0]?.[0]).toContain(
      'https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc',
    )
    expect(JSON.stringify(run.mock.calls)).not.toContain('jwt=')
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      maxBytes: 10 * 1024 * 1024,
      encoding: 'base64',
    })
  })

  it('shares the same cache entry for equivalent blob and raw URLs', async () => {
    const run = vi.fn<GhRunner>().mockResolvedValue(file())
    const service = new PullRequestImageService(run)
    await service.image(url)
    await service.image('https://raw.githubusercontent.com/owner/repo/abc/docs/before.png')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
