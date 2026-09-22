import { gt, rcompare, valid } from 'semver'

// GitHub release facts shared by the electron-updater provider and the deb
// (manual) update check. This module must not import electron or
// electron-updater: the manual path runs in packages that never load them.

export const releaseRepository = 'Leonxlnx/tastecode'
export const releasePageUrl = `https://github.com/${releaseRepository}/releases`

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
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function releaseCandidate(row: unknown): { tag: string; version: string } | undefined {
  if (
    typeof row !== 'object' ||
    row === null ||
    !('tag_name' in row) ||
    typeof row.tag_name !== 'string' ||
    !('draft' in row) ||
    typeof row.draft !== 'boolean' ||
    !('published_at' in row) ||
    (typeof row.published_at !== 'string' && row.published_at !== null)
  ) {
    throw new Error('GitHub release check returned invalid release metadata.')
  }
  if (row.draft || row.published_at === null) return undefined
  const version = versionFromTag(row.tag_name)
  return version ? { tag: row.tag_name, version } : undefined
}

/**
 * Read-only check against the public releases API for packages without an
 * updater (the deb). It scans published releases by semantic version so a
 * later-published proof for an older build cannot hide the current update.
 */
export async function fetchLatestRelease(
  fetchFn: FetchLike = fetch,
): Promise<LatestRelease | undefined> {
  const releases: Array<{ tag: string; version: string }> = []
  for (let page = 1; page <= 10; page++) {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchFn(
        `https://api.github.com/repos/${releaseRepository}/releases?per_page=100&page=${page}`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'tastecode-desktop',
          },
        },
      )
    } catch (cause) {
      throw new Error(`GitHub release check failed: ${causeMessage(cause)}`)
    }
    if (!response.ok)
      throw new Error(`GitHub release check failed with HTTP ${response.status}.`)

    let rows: unknown
    try {
      rows = await response.json()
    } catch (cause) {
      throw new Error(`GitHub release check returned invalid JSON: ${causeMessage(cause)}`)
    }
    if (!Array.isArray(rows))
      throw new Error('GitHub release check returned an invalid release list.')
    for (const row of rows) {
      const release = releaseCandidate(row)
      if (release) releases.push(release)
    }
    if (rows.length < 100) {
      releases.sort((left, right) => rcompare(left.version, right.version))
      const latest = releases[0]
      return latest
        ? {
            version: latest.version,
            releasesUrl: `${releasePageUrl}/tag/${encodeURIComponent(latest.tag)}`,
          }
        : undefined
    }
  }
  throw new Error('GitHub release history exceeded the update lookup limit.')
}
