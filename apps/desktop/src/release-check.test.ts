import { describe, expect, it, vi } from 'vitest'
import {
  fetchLatestRelease,
  isNewerVersion,
  versionFromTag,
  type FetchLike,
} from './release-check.js'

function ok(body: unknown): FetchLike {
  return vi.fn(async () => ({ ok: true, json: async () => body }))
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
  it('returns the published version and releases page', async () => {
    const fetchFn = ok({ tag_name: 'v0.2.0' })
    await expect(fetchLatestRelease(fetchFn)).resolves.toEqual({
      version: '0.2.0',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/Leonxlnx/tastecode/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
      }),
    )
    expect(vi.mocked(fetchFn).mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it.each([404, 403, 500])('treats HTTP %i as no signal', async (status) => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ message: 'nope' }),
    }))
    await expect(fetchLatestRelease(fetchFn)).resolves.toBeUndefined()
  })

  it('swallows network failures and malformed payloads', async () => {
    await expect(
      fetchLatestRelease(
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        }),
      ),
    ).resolves.toBeUndefined()
    await expect(
      fetchLatestRelease(
        vi.fn(async () => ({
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token')
          },
        })),
      ),
    ).resolves.toBeUndefined()
    await expect(fetchLatestRelease(ok({ tag_name: 'docs' }))).resolves.toBeUndefined()
    await expect(fetchLatestRelease(ok({}))).resolves.toBeUndefined()
    await expect(fetchLatestRelease(ok(null))).resolves.toBeUndefined()
  })
})
