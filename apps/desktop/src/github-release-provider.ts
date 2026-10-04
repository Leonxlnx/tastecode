import type { AppUpdater, ResolvedUpdateFileInfo, UpdateInfo } from 'electron-updater'
import { Provider, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import { eq, gt, lte, rcompare, valid } from 'semver'
import { z } from 'zod'

export const releaseRepository = 'Leonxlnx/tastecode'
const releasePage = `https://github.com/${releaseRepository}/releases`
const releaseApi = `https://api.github.com/repos/${releaseRepository}/releases`
const FEED_ENTRIES = 10
const tagLink = new RegExp(`href="${releasePage.replaceAll('.', '\\.')}/tag/([^"?#]+)"`, 'g')
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
export type ReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>
export type ReleaseProviderOptions = { provider: 'custom'; fetch?: ReleaseFetch }
type InstalledVersion = Pick<AppUpdater, 'currentVersion'>

/** GitHub asked for the next release lookup to wait until `retryAt`. */
export class UpdateCheckDeferredError extends Error {
  constructor(readonly retryAt: number) {
    const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000))
    super(
      `GitHub is limiting update checks from this network. TasteCode will try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    )
    this.name = 'UpdateCheckDeferredError'
  }
}

// GitHub's rate limit windows last an hour at most.
const MAX_DEFERRAL = 60 * 60 * 1000

/** When a rate-limited response says the next request may succeed. */
export function deferredUntil(response: Response, now = Date.now()): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined
  const wait = (milliseconds: number) => now + Math.min(Math.max(milliseconds, 0), MAX_DEFERRAL)
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return wait(retryAfter * 1000)
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    // The reset is a moment on GitHub's clock; measure it against GitHub's own
    // Date header so a wrong local clock neither waits a day nor retries early.
    const answered = Date.parse(response.headers.get('date') ?? '')
    if (Number.isFinite(reset) && reset > 0)
      return wait(reset * 1000 - (Number.isFinite(answered) ? answered : now))
  }
  return response.status === 429 ? wait(60_000) : undefined
}

function versionFromTag(tag: string): string | undefined {
  const version = tag.replace(/^v/, '')
  return valid(version) ? version : undefined
}

/** Tags in GitHub's release feed: published releases and bare tags, newest ten first. */
export function feedTags(feed: string): string[] {
  const tags: string[] = []
  for (const [, encoded] of feed.matchAll(tagLink)) {
    try {
      tags.push(decodeURIComponent(encoded!))
    } catch {
      // A malformed escape cannot name a tag TasteCode released.
    }
  }
  return tags
}

/** Tags of versions above `current`, highest version first. */
export function newerTags(tags: string[], current: string): string[] {
  const newer = new Map<string, string>()
  for (const tag of tags) {
    const version = versionFromTag(tag)
    if (version && gt(version, current) && !newer.has(version)) newer.set(version, tag)
  }
  return [...newer.keys()].sort(rcompare).map((version) => newer.get(version)!)
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

export class GitHubReleaseProvider extends Provider<UpdateInfo> {
  private readonly platform: string
  private readonly fetch: ReleaseFetch

  constructor(
    options: ReleaseProviderOptions,
    private readonly installed: InstalledVersion,
    runtime: ProviderRuntimeOptions,
  ) {
    super({ ...runtime, isUseMultipleRangeRequest: false })
    this.platform = runtime.platform
    this.fetch = options.fetch ?? fetch
  }

  /** The response, or undefined for a 404. */
  private async request(url: string, accept: string): Promise<Response | undefined> {
    let response: Response
    try {
      response = await this.fetch(url, {
        headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`GitHub could not be reached to check for updates (${detail}).`, { cause })
    }
    const retryAt = deferredUntil(response)
    if (response.status === 404 || retryAt !== undefined || !response.ok) {
      await response.body?.cancel()
      if (response.status === 404) return undefined
      if (retryAt !== undefined) throw new UpdateCheckDeferredError(retryAt)
      throw new Error(`GitHub answered the update check with HTTP ${response.status}.`)
    }
    return response
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const current = this.installed.currentVersion.version
    // Installs behind one office or VPN address share GitHub's unauthenticated
    // API limit of 60 requests an hour, and a 304 still counts. The release
    // feed is not part of that limit, so a check that finds nothing newer
    // spends none of it.
    const feed = await this.request(`${releasePage}.atom`, 'application/atom+xml')
    if (!feed) throw new Error('GitHub could not find the TasteCode release feed.')
    const atom = await feed.text()
    const tags = feedTags(atom)
    const entries = atom.match(/<entry(?:\s|>)/g)?.length ?? 0
    const coversInstalled = tags.some((tag) => {
      const version = versionFromTag(tag)
      return version !== undefined && lte(version, current)
    })
    // Newer bare tags can push every release out of the feed's ten entries,
    // and an entry whose tag cannot be read may be the newer release.
    if (!coversInstalled || tags.length < entries) return this.latestFromReleaseList()
    const newest = newerTags(tags, current)[0]
    if (newest) {
      const row = await this.request(
        `${releaseApi}/tags/${encodeURIComponent(newest)}`,
        'application/vnd.github+json',
      )
      const release = row ? releaseSchema.parse(await row.json()) : undefined
      if (release && !release.draft && release.published_at)
        return releaseUpdateInfo(release, this.platform, process.arch)
      // A pushed tag whose release is still a draft is invisible here, and any
      // number of them may sit above the real release. One list answers all.
      return this.latestFromReleaseList()
    }
    // The feed holds the ten most recently published entries, not the ten highest
    // versions. While it still lists the installed release, everything published
    // after it is in view. Once later-published older versions have pushed it out,
    // a newer release published in between can be hidden too.
    const listsInstalled = tags.some((tag) => {
      const version = versionFromTag(tag)
      return version !== undefined && eq(version, current)
    })
    if (entries >= FEED_ENTRIES && !listsInstalled) return this.latestFromReleaseList()
    return {
      version: current,
      files: [],
      path: '',
      sha512: '',
      releaseDate: new Date().toISOString(),
    }
  }

  private async latestFromReleaseList(): Promise<UpdateInfo> {
    const releases: unknown[] = []
    // Scan pages rather than trusting GitHub's "Latest" badge or excluding beta
    // releases. Version order decides; publishing an old proof must not hide an update.
    for (let page = 1; page <= 10; page++) {
      const response = await this.request(
        `${releaseApi}?per_page=100&page=${page}`,
        'application/vnd.github+json',
      )
      const rows: unknown = await response?.json()
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
