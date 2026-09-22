import { describe, expect, it, vi } from 'vitest'
import {
  fetchLatestRelease,
  isNewerVersion,
  versionFromTag,
  type FetchLike,
} from './release-check.js'

function ok(body: unknown): FetchLike {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))
}

describe('release tags and versions', () => {
  it('reads semver versions from release tags', () => {
    expect(versionFromTag('v0.1.0-beta.9')).toBe('0.1.0-beta.9')
    expect(versionFromTag('0.1.0')).toBe('0.1.0')
    expect(versionFromTag('docs')).toBeUndefined()
    expect(versionFromTag('v0.1.0-beta.08')).toBeUndefined()
  })

  it.each([
    // Release numbers.
    ['0.1.0', '0.2.0', true],
    ['0.1.0', '0.1.1', true],
    ['1.0.0', '2.0.0', true],
    ['0.2.0', '0.1.0', false],
    ['0.1.0', '0.1.0', false],
    // Prereleases: numeric identifiers order numerically, not lexically.
    ['0.1.0-beta.6', '0.1.0-beta.9', true],
    ['0.1.0-beta.9', '0.1.0-beta.10', true],
    ['0.1.0-beta.9', '0.1.0-beta.6', false],
    // The release outranks every one of its own prereleases.
    ['0.1.0-beta.9', '0.1.0', true],
    ['0.1.0', '0.1.0-beta.9', false],
    // Identifier ranking: numeric < alphanumeric, shorter prefix < longer.
    ['1.0.0-alpha', '1.0.0-alpha.1', true],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', true],
    ['1.0.0-beta', '1.0.0-alpha.1', false],
    ['1.0.0-beta.2', '1.0.0-beta', false],
    // Optional v prefixes and ignored build metadata.
    ['v0.1.0-beta.8', 'v0.1.0-beta.9', true],
    ['0.1.0', 'v0.1.0+build5', false],
    // Unparseable input is never "newer".
    ['0.1.0', 'docs', false],
    ['not-a-version', '1.0.0', false],
    ['0.1.0', '0.1.0-beta.08', false],
  ])('isNewerVersion(%s, %s) === %s', (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected)
  })
})

describe('fetchLatestRelease', () => {
  it('returns the greatest published semantic version and its release page', async () => {
    const fetchFn = ok([
      { tag_name: 'v0.1.0-beta.8', draft: false, published_at: '2026-09-22T00:00:00Z' },
      { tag_name: 'v0.2.0', draft: false, published_at: '2026-09-21T00:00:00Z' },
      { tag_name: 'v9.0.0', draft: true, published_at: '2026-09-23T00:00:00Z' },
    ])
    await expect(fetchLatestRelease(fetchFn)).resolves.toEqual({
      version: '0.2.0',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/tag/v0.2.0',
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/Leonxlnx/tastecode/releases?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
      }),
    )
    expect(vi.mocked(fetchFn).mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it.each([403, 500])('reports HTTP %i as a failed release check', async (status) => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ message: 'nope' }),
    }))
    await expect(fetchLatestRelease(fetchFn)).rejects.toThrow(
      `GitHub release check failed with HTTP ${status}.`,
    )
  })

  it('reports network failures and malformed payloads', async () => {
    await expect(
      fetchLatestRelease(
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        }),
      ),
    ).rejects.toThrow('GitHub release check failed: fetch failed')
    await expect(
      fetchLatestRelease(
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token')
          },
        })),
      ),
    ).rejects.toThrow('GitHub release check returned invalid JSON: Unexpected token')
    await expect(fetchLatestRelease(ok({ tag_name: 'docs' }))).rejects.toThrow(
      'GitHub release check returned an invalid release list.',
    )
    await expect(fetchLatestRelease(ok(null))).rejects.toThrow(
      'GitHub release check returned an invalid release list.',
    )
  })

  it('returns no signal when the repository has no published app release', async () => {
    await expect(
      fetchLatestRelease(
        ok([
          { tag_name: 'docs', draft: false, published_at: '2026-09-22T00:00:00Z' },
          { tag_name: 'v0.2.0', draft: true, published_at: '2026-09-22T00:00:00Z' },
        ]),
      ),
    ).resolves.toBeUndefined()
  })

  it('scans subsequent pages while filtering drafts and non-version tags', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      tag_name: index === 0 ? 'v0.1.0' : `docs-${index}`,
      draft: false,
      published_at: '2026-09-22T00:00:00Z',
    }))
    const fetchFn: FetchLike = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('page=1')
          ? firstPage
          : [
              { tag_name: 'v9.0.0', draft: true, published_at: '2026-09-23T00:00:00Z' },
              { tag_name: 'v0.2.0', draft: false, published_at: '2026-09-21T00:00:00Z' },
            ],
    }))

    await expect(fetchLatestRelease(fetchFn)).resolves.toEqual({
      version: '0.2.0',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/tag/v0.2.0',
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed release metadata instead of trusting a partial row', async () => {
    await expect(fetchLatestRelease(ok([{ tag_name: 'v0.2.0', draft: false }]))).rejects.toThrow(
      'GitHub release check returned invalid release metadata.',
    )
  })
})
