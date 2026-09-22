import type { AppUpdater, ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater'
import { Provider, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import { rcompare, valid } from 'semver'
import { z } from 'zod'

export const releaseRepository = 'Leonxlnx/tastecode'
const assetSchema = z.object({
  name: z.string(),
  state: z.literal('uploaded'),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  browser_download_url: z.string().url(),
})
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  published_at: z.string().datetime({ offset: true }).nullable(),
  assets: z.array(z.unknown()),
})
type Release = z.infer<typeof releaseSchema>
export type ReleaseAsset = z.infer<typeof assetSchema>
export type AssetUpdateInfo = UpdateInfo & { asset: ReleaseAsset }

function versionFromTag(tag: string): string | undefined {
  const version = tag.replace(/^v/, '')
  return valid(version) ? version : undefined
}

export function selectLatestRelease(rows: unknown[]): Release {
  const releases = rows
    .map((row) => releaseSchema.parse(row))
    .filter((release) => !release.draft && release.published_at && versionFromTag(release.tag_name))
  releases.sort((a, b) => rcompare(versionFromTag(a.tag_name)!, versionFromTag(b.tag_name)!))
  const latest = releases[0]
  if (!latest) throw new Error('No published TasteCode release is available.')
  return latest
}

export function releaseUpdateInfo(
  release: Release,
  platform: string,
  arch: string,
): AssetUpdateInfo {
  const version = versionFromTag(release.tag_name)
  if (!version || !release.published_at) throw new Error('Invalid release version or date.')
  const target = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : undefined
  if (!target) throw new Error('App updates are supported on Windows and macOS.')
  const extension = target === 'mac' ? 'dmg' : 'exe'
  const name = `TasteCode-${version}-${target}-${arch}.${extension}`
  const matches = release.assets.filter(
    (asset) =>
      typeof asset === 'object' && asset !== null && 'name' in asset && asset.name === name,
  )
  if (matches.length !== 1) throw new Error(`The newest release is missing ${name}.`)
  const asset = assetSchema.parse(matches[0])
  const expected = `https://github.com/${releaseRepository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`
  if (asset.browser_download_url !== expected)
    throw new Error('The update asset URL does not match the TasteCode release.')
  // GitHub supplies SHA-256, not electron-updater's required SHA-512. The download
  // adapter verifies SHA-256 first, then supplies real SHA-512 metadata locally.
  return { version, releaseDate: release.published_at, files: [], path: '', sha512: '', asset }
}

export function assetFromUpdateInfo(info: UpdateInfo): ReleaseAsset {
  if (!('asset' in info)) throw new Error('Missing GitHub update asset.')
  return assetSchema.parse(info.asset)
}

export class GitHubReleaseProvider extends Provider<AssetUpdateInfo> {
  private readonly platform: string

  constructor(_options: unknown, _updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    super({ ...runtime, isUseMultipleRangeRequest: false })
    this.platform = runtime.platform
  }

  async getLatestVersion(): Promise<AssetUpdateInfo> {
    const releases: unknown[] = []
    // Scan pages rather than trusting GitHub's "Latest" badge or excluding beta
    // releases. Version order decides; publishing an old proof must not hide an update.
    for (let page = 1; page <= 10; page++) {
      const raw = await this.executor.request({
        ...this.createRequestOptions(
          new URL(
            `https://api.github.com/repos/${releaseRepository}/releases?per_page=100&page=${page}`,
          ),
          { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        ),
        timeout: 20_000,
      })
      const rows: unknown = JSON.parse(raw ?? 'null')
      if (!Array.isArray(rows)) throw new Error('GitHub returned an invalid release list.')
      releases.push(...rows)
      if (rows.length < 100)
        return releaseUpdateInfo(selectLatestRelease(releases), this.platform, process.arch)
    }
    throw new Error('GitHub release history exceeded the update lookup limit.')
  }

  resolveFiles(): ResolvedUpdateFileInfo[] {
    throw new Error('GitHub assets must be verified and prepared before installation.')
  }
}
