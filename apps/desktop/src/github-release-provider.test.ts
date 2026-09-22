import { describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import {
  GitHubReleaseProvider,
  releaseUpdateInfo,
  selectLatestRelease,
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

  it('checks all pages without credentials or YAML requests', async () => {
    const newest = release()
    newest.assets = newest.assets.map((asset) => ({
      ...asset,
      name: asset.name.replace('mac-arm64', `mac-${process.arch}`),
      browser_download_url: asset.browser_download_url.replace('mac-arm64', `mac-${process.arch}`),
    }))
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify(
          Array.from({ length: 100 }, () => release('0.1.0-beta.7', '2026-09-19T00:00:00Z')),
        ),
      )
      .mockResolvedValueOnce(JSON.stringify([newest]))
    const provider = new GitHubReleaseProvider(
      {},
      {} as AppUpdater,
      {
        platform: 'darwin',
        isUseMultipleRangeRequest: false,
        executor: { request },
      } as unknown as ProviderRuntimeOptions,
    )
    const result = await provider.getLatestVersion()
    expect(result.version).toBe('0.1.0-beta.8')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![0]).toMatchObject({
      hostname: 'api.github.com',
      path: '/repos/Leonxlnx/tastecode/releases?per_page=100&page=2',
    })
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/authorization|\.yml/i)
    expect(() => provider.resolveFiles()).toThrow(/verified/)
  })
})
