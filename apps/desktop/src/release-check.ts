import { gt, valid } from 'semver'

// GitHub release facts shared by the electron-updater provider and the deb
// (manual) update check. This module must not import electron or
// electron-updater: the manual path runs in packages that never load them.

export const releaseRepository = 'Leonxlnx/tastecode'

export function versionFromTag(tag: string): string | undefined {
  const version = tag.replace(/^v/, '')
  return valid(version) ?? undefined
}

export function isNewerVersion(current: string, latest: string): boolean {
  const currentVersion = versionFromTag(current)
  const latestVersion = versionFromTag(latest)
  return Boolean(currentVersion && latestVersion && gt(latestVersion, currentVersion))
}

export type LatestRelease = { version: string; releasesUrl: string }

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/**
 * Read-only check against the public releases API for packages without an
 * updater (the deb). /releases/latest only ever names a published release —
 * drafts are invisible without credentials — so this can never point at work
 * that is not shipped. Any failure (offline, rate limit, missing release)
 * returns undefined: no signal, never an error.
 */
export async function fetchLatestRelease(
  fetchFn: FetchLike = fetch,
): Promise<LatestRelease | undefined> {
  try {
    const response = await fetchFn(
      `https://api.github.com/repos/${releaseRepository}/releases/latest`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'tastecode-desktop',
        },
      },
    )
    if (!response.ok) return undefined
    const data: unknown = await response.json()
    const tag =
      typeof data === 'object' && data !== null && 'tag_name' in data ? data.tag_name : undefined
    const version = typeof tag === 'string' ? versionFromTag(tag) : undefined
    if (!version) return undefined
    return {
      version,
      releasesUrl: `https://github.com/${releaseRepository}/releases/latest`,
    }
  } catch {
    return undefined
  }
}
