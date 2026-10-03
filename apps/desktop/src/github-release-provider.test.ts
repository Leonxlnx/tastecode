import { SemVer } from 'semver'
import { describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import {
  deferredUntil,
  feedTags,
  GitHubReleaseProvider,
  newerTags,
  releaseUpdateInfo,
  selectLatestRelease,
  UpdateCheckDeferredError,
  type ReleaseFetch,
} from './github-release-provider.js'

function release(version = '0.1.0-beta.8', date = '2026-09-20T00:00:00Z') {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: true,
    published_at: date,
    assets: [
      ['mac-arm64', 'dmg'],
      ['win-x64', 'exe'],
    ].map(([target, ext]) => {
      const name = `TasteCode-${version}-${target}.${ext}`
      return {
        name,
        state: 'uploaded',
        size: 100,
        digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: `https://github.com/Leonxlnx/tastecode/releases/download/v${version}/${name}`,
      }
    }),
  }
}

describe('GitHub asset releases', () => {
  it('keeps 0.1.1 ahead of an older Linux-only beta published later', () => {
    const beta = { ...release(), assets: [{ name: 'TasteCode-0.1.0-beta.8-linux-amd64.deb' }] }
    const stable = { ...release('0.1.1', '2026-09-19T00:00:00Z'), prerelease: false }
    const draft = { ...release('2.0.0', '2026-09-21T00:00:00Z'), draft: true }
    const latest = selectLatestRelease([stable, draft, beta])
    expect(releaseUpdateInfo(latest, 'win32', 'x64').version).toBe('0.1.1')
    expect(releaseUpdateInfo(latest, 'darwin', 'arm64').version).toBe('0.1.1')
  })

  it.each([
    ['0.1.0-beta.10', '0.1.0-beta.9'],
    ['0.1.0', '0.1.0-beta.10'],
    ['0.1.2-beta.1', '0.1.1'],
    ['0.10.0', '0.9.0'],
  ])('selects %s ahead of the more recently published %s', (higher, lower) => {
    expect(
      selectLatestRelease([
        release(lower, '2026-09-21T00:00:00Z'),
        release(higher, '2026-09-19T00:00:00Z'),
      ]).tag_name,
    ).toBe(`v${higher}`)
  })

  it('ignores non-app tags and invalid semantic versions', () => {
    const beta = release()
    expect(
      selectLatestRelease([
        { ...release(), tag_name: 'docs', published_at: '2026-09-21T00:00:00Z' },
        { ...release(), tag_name: 'v0.1.0-beta.08', published_at: '2026-09-21T00:00:00Z' },
        beta,
      ]).tag_name,
    ).toBe(beta.tag_name)
  })

  it.each(['0.1.0-beta.8', '0.1.1'])('resolves the matching EXE and DMG for %s', (version) => {
    const latest = selectLatestRelease([release(version)])
    expect(releaseUpdateInfo(latest, 'win32', 'x64').version).toBe(version)
    expect(releaseUpdateInfo(latest, 'darwin', 'arm64').asset.name).toMatch(/\.dmg$/)
    expect(releaseUpdateInfo(latest, 'win32', 'x64').asset.name).toMatch(/\.exe$/)
    expect(latest.assets).toHaveLength(2)
    expect(() => releaseUpdateInfo(latest, 'darwin', 'x64')).toThrow(/missing/)
  })

  it('does not silently choose an older release when the newest one is incomplete', () => {
    const latest = selectLatestRelease([
      release('0.1.0-beta.7', '2026-09-19T00:00:00Z'),
      {
        ...release(),
        assets: [],
      },
    ])
    expect(() => releaseUpdateInfo(latest, 'darwin', 'arm64')).toThrow(/missing/)
  })

  it.each([
    { digest: null },
    { digest: `sha256:${'a'.repeat(63)}` },
    { size: 0 },
    { state: 'new' },
    { browser_download_url: 'https://other.example/update.dmg' },
    { browser_download_url: 'https://github.com/other/repo/releases/download/v1/update.dmg' },
  ])('rejects unsafe or incomplete metadata: %j', (change) => {
    const latest = release()
    Object.assign(latest.assets[0]!, change)
    expect(() => releaseUpdateInfo(selectLatestRelease([latest]), 'darwin', 'arm64')).toThrow()
  })

  it('rejects duplicate installer names', () => {
    const latest = release()
    latest.assets.push(latest.assets[0]!)
    expect(() => releaseUpdateInfo(selectLatestRelease([latest]), 'darwin', 'arm64')).toThrow(
      /missing/,
    )
  })

  it('reads release and bare tags from the GitHub release feed', () => {
    expect(
      feedTags(feed('linux-preview-e9ac0a03', 'v0.1.1', 'v0.1.0-beta.8', 'v1.0.0%2Bmac')),
    ).toEqual(['linux-preview-e9ac0a03', 'v0.1.1', 'v0.1.0-beta.8', 'v1.0.0+mac'])
    expect(feedTags('<link href="https://github.com/other/repo/releases/tag/v9.0.0"/>')).toEqual([])
  })

  it('orders newer tags by version, not by feed position', () => {
    expect(
      newerTags(
        ['v0.1.0-beta.10', 'linux-preview-e9ac0a03', 'v0.2.0', 'v0.1.1', '0.2.0', 'v0.1.2-beta.1'],
        '0.1.1',
      ),
    ).toEqual(['v0.2.0', 'v0.1.2-beta.1'])
  })

  it('finds nothing newer without spending API requests', async () => {
    const fetch = feedFetch(feed('linux-preview-e9ac0a03', 'v0.1.1', 'v0.1.0-beta.9'))
    const result = await providerWith(fetch, '0.1.1').getLatestVersion()
    expect(result).toMatchObject({ version: '0.1.1', files: [] })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe('https://github.com/Leonxlnx/tastecode/releases.atom')
  })

  it('confirms the newest tag through the API with one request', async () => {
    const fetch = feedFetch(feed('v0.1.2', 'v0.1.1'), {
      'v0.1.2': Response.json(localRelease('0.1.2')),
    })
    expect((await providerWith(fetch, '0.1.1').getLatestVersion()).version).toBe('0.1.2')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://github.com/Leonxlnx/tastecode/releases.atom',
      'https://api.github.com/repos/Leonxlnx/tastecode/releases/tags/v0.1.2',
    ])
    expect(JSON.stringify(fetch.mock.calls)).not.toMatch(/authorization|\.yml/i)
  })

  it('looks past any number of unpublished tags with one list request', async () => {
    const drafts = ['v0.2.5', 'v0.2.4', 'v0.2.3', 'v0.2.2', 'v0.2.1', 'v0.2.0']
    const fetch = feedFetch(
      feed(...drafts, 'v0.1.3', 'v0.1.2'),
      { 'v0.2.5': new Response(null, { status: 404 }) },
      [localRelease('0.1.3'), localRelease('0.1.2')],
    )
    expect((await providerWith(fetch, '0.1.2').getLatestVersion()).version).toBe('0.1.3')
    expect(fetch.mock.calls.map(([url]) => url.split('/').pop())).toEqual([
      'releases.atom',
      'v0.2.5',
      'releases?per_page=100&page=1',
    ])
  })

  it('treats a tag whose release has no publication date as unpublished', async () => {
    const fetch = feedFetch(
      feed('v0.1.3', 'v0.1.2'),
      { 'v0.1.3': Response.json({ ...localRelease('0.1.3'), published_at: null }) },
      [localRelease('0.1.2')],
    )
    expect((await providerWith(fetch, '0.1.2').getLatestVersion()).version).toBe('0.1.2')
  })

  it('offers a release published as a GitHub pre-release to every install', async () => {
    // Every alpha release is published as a pre-release; the flag must not hide it.
    const fetch = feedFetch(feed('v0.1.3', 'v0.1.2'), {
      'v0.1.3': Response.json({ ...localRelease('0.1.3'), prerelease: true }),
    })
    expect((await providerWith(fetch, '0.1.2').getLatestVersion()).version).toBe('0.1.3')
    const flagged = { ...release('0.1.3', '2026-09-19T00:00:00Z'), prerelease: true }
    const normal = { ...release('0.1.2', '2026-09-21T00:00:00Z'), prerelease: false }
    expect(selectLatestRelease([normal, flagged]).tag_name).toBe('v0.1.3')
  })

  it('does not fall back to an older release when the newest one is incomplete', async () => {
    const incomplete = { ...localRelease('0.1.3'), assets: [] }
    const fetch = feedFetch(feed('v0.1.3', 'v0.1.2', 'v0.1.1'), {
      'v0.1.3': Response.json(incomplete),
      'v0.1.2': Response.json(localRelease('0.1.2')),
    })
    await expect(providerWith(fetch, '0.1.1').getLatestVersion()).rejects.toThrow(/missing/)
  })

  it('reads every page when newer tags pushed the installed version out of the feed', async () => {
    const fetch = vi
      .fn<ReleaseFetch>()
      .mockResolvedValueOnce(
        new Response(feed(...Array.from({ length: 10 }, (_, n) => `linux-preview-${n}`))),
      )
      .mockResolvedValueOnce(
        Response.json(
          Array.from({ length: 100 }, () => release('0.1.0-beta.7', '2026-09-19T00:00:00Z')),
        ),
      )
      .mockResolvedValueOnce(Response.json([localRelease()]))
    const provider = providerWith(fetch, '0.1.0-beta.7')
    const result = await provider.getLatestVersion()
    expect(result.version).toBe('0.1.0-beta.8')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[2]![0]).toBe(
      'https://api.github.com/repos/Leonxlnx/tastecode/releases?per_page=100&page=2',
    )
    expect(() => provider.resolveFiles()).toThrow(/verified/)
  })

  it('defers a rate-limited lookup until GitHub resets the limit', async () => {
    const reset = Math.floor(Date.now() / 1000) + 25 * 60
    const fetch = feedFetch(feed('v0.1.2', 'v0.1.1'), {
      'v0.1.2': new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      }),
    })
    const lookup = providerWith(fetch, '0.1.1').getLatestVersion()
    await expect(lookup).rejects.toBeInstanceOf(UpdateCheckDeferredError)
    await expect(lookup).rejects.toMatchObject({ retryAt: reset * 1000 })
    await expect(lookup).rejects.toThrow(/about 25 minutes/)
  })

  it('falls back to the release list when the feed answers with an HTML error page', async () => {
    const fetch = vi
      .fn<ReleaseFetch>()
      .mockResolvedValueOnce(new Response('<!DOCTYPE html><title>Unicorn!</title>'))
      .mockResolvedValueOnce(Response.json([localRelease('0.1.2')]))
    expect((await providerWith(fetch, '0.1.1').getLatestVersion()).version).toBe('0.1.2')
  })

  it.each([
    ['the feed', 'releases.atom', 502],
    ['the release lookup', 'tags/v0.1.2', 500],
  ])('reports a server error from %s', async (_label, failing, status) => {
    const fetch = vi.fn<ReleaseFetch>(async (url) =>
      url.endsWith(failing)
        ? new Response('', { status })
        : url.endsWith('.atom')
          ? new Response(feed('v0.1.2', 'v0.1.1'))
          : Response.json(localRelease('0.1.2')),
    )
    await expect(providerWith(fetch, '0.1.1').getLatestVersion()).rejects.toThrow(`HTTP ${status}`)
  })

  it('rejects a release lookup that is not a release', async () => {
    const fetch = feedFetch(feed('v0.1.2', 'v0.1.1'), {
      'v0.1.2': Response.json({ message: 'Moved Permanently' }),
    })
    await expect(providerWith(fetch, '0.1.1').getLatestVersion()).rejects.toThrow()
  })

  it.each([
    ['a beta install', '0.1.0-beta.9', '0.1.1'],
    ['an install newer than every release', '0.1.3', '0.1.3'],
    ['an install of the newest release', '0.1.1', '0.1.1'],
  ])('handles %s', async (_label, installed, offered) => {
    const fetch = feedFetch(feed('linux-preview-e9ac0a03', 'v0.1.1', 'v0.1.0-beta.9'), {
      'v0.1.1': Response.json(localRelease('0.1.1')),
    })
    expect((await providerWith(fetch, installed).getLatestVersion()).version).toBe(offered)
  })

  it.each([
    [429, { 'retry-after': '120' }, 120_000],
    [403, { 'retry-after': '30' }, 30_000],
    [429, {}, 60_000],
  ])('reads when a %i answer may be retried from %j', (status, headers, delay) => {
    const now = Date.parse('2026-10-03T10:00:00Z')
    expect(deferredUntil(new Response(null, { status, headers }), now)).toBe(now + delay)
  })

  it.each([
    ['a day behind', '2026-10-02T10:00:00Z'],
    ['a day ahead', '2026-10-04T10:00:00Z'],
    ['correct', '2026-10-03T10:00:00Z'],
  ])("waits for the reset by GitHub's clock when the local clock is %s", (_label, local) => {
    const now = Date.parse(local)
    const github = Date.parse('2026-10-03T10:00:00Z')
    const response = new Response(null, {
      status: 403,
      headers: {
        date: new Date(github).toUTCString(),
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String((github + 20 * 60 * 1000) / 1000),
      },
    })
    expect(deferredUntil(response, now)).toBe(now + 20 * 60 * 1000)
  })

  it('never waits longer than an hour, whatever GitHub answers', () => {
    const now = Date.parse('2026-10-03T10:00:00Z')
    const response = new Response(null, { status: 429, headers: { 'retry-after': '86400' } })
    expect(deferredUntil(response, now)).toBe(now + 60 * 60 * 1000)
  })

  it('reports other GitHub failures without treating them as a rate limit', async () => {
    const forbidden = vi.fn<ReleaseFetch>().mockResolvedValue(new Response('', { status: 403 }))
    await expect(providerWith(forbidden).getLatestVersion()).rejects.toThrow(/HTTP 403/)
    const offline = vi.fn<ReleaseFetch>().mockRejectedValue(new TypeError('fetch failed'))
    await expect(providerWith(offline).getLatestVersion()).rejects.toThrow(
      /could not be reached .*fetch failed/,
    )
  })
})

function feed(...tags: string[]) {
  const entries = tags.map(
    (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1314983809/${tag}</id>
    <link rel="alternate" type="text/html" href="https://github.com/Leonxlnx/tastecode/releases/tag/${tag}"/>
  </entry>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link type="text/html" rel="alternate" href="https://github.com/Leonxlnx/tastecode/releases"/>
${entries.join('\n')}
</feed>`
}

function feedFetch(atom: string, releases: Record<string, Response> = {}, list?: unknown[]) {
  return vi.fn<ReleaseFetch>(async (url) => {
    if (url.endsWith('/releases.atom')) return new Response(atom)
    if (list && url.endsWith('/releases?per_page=100&page=1')) return Response.json(list)
    const tag = /\/releases\/tags\/(.+)$/.exec(url)?.[1]
    const answer = tag === undefined ? undefined : releases[decodeURIComponent(tag)]
    if (!answer) throw new Error(`Unexpected request: ${url}`)
    return answer
  })
}

function localRelease(version?: string) {
  const newest = release(version)
  newest.assets = newest.assets.map((asset) => ({
    ...asset,
    name: asset.name.replace('mac-arm64', `mac-${process.arch}`),
    browser_download_url: asset.browser_download_url.replace('mac-arm64', `mac-${process.arch}`),
  }))
  return newest
}

function providerWith(fetch: ReleaseFetch, installed = '0.1.0') {
  return new GitHubReleaseProvider(
    { provider: 'custom', fetch },
    { currentVersion: new SemVer(installed) } as AppUpdater,
    { platform: 'darwin', isUseMultipleRangeRequest: false } as unknown as ProviderRuntimeOptions,
  )
}
