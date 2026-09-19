// Dependency-free GitHub release facts shared by the electron-updater provider
// and the deb (manual) update check. This module must not import electron or
// electron-updater: the manual path runs in packages that never load them.

export const releaseRepository = 'Leonxlnx/tastecode'

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/

export function versionFromTag(tag: string): string | undefined {
  const version = tag.replace(/^v/, '')
  const match = semverPattern.exec(version)
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) return undefined
  return version
}

type SemverParts = { release: [number, number, number]; prerelease: string[] }

function semverParts(value: string): SemverParts | undefined {
  const match = semverPattern.exec(value.replace(/^v/, ''))
  if (!match) return undefined
  const prerelease = match[4]?.split('.') ?? []
  // Numeric prerelease identifiers must not carry leading zeros (semver §9).
  if (prerelease.some((part) => /^0\d+$/.test(part))) return undefined
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  }
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const numeric = /^\d+$/
  const leftNumeric = numeric.test(left)
  const rightNumeric = numeric.test(right)
  if (leftNumeric && rightNumeric) {
    // Leading zeros are rejected by semverParts, so length orders first.
    if (left.length !== right.length) return left.length - right.length
    return left < right ? -1 : left > right ? 1 : 0
  }
  // Numeric identifiers rank below alphanumeric ones.
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSemver(left: SemverParts, right: SemverParts): number {
  for (const index of [0, 1, 2] as const) {
    const delta = left.release[index] - right.release[index]
    if (delta !== 0) return delta
  }
  // A release outranks every one of its own prereleases: 0.1.0 > 0.1.0-beta.9.
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1
  const shared = Math.min(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < shared; index++) {
    const delta = comparePrereleaseIdentifiers(left.prerelease[index]!, right.prerelease[index]!)
    if (delta !== 0) return delta
  }
  return left.prerelease.length - right.prerelease.length
}

export function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = semverParts(current)
  const latestParts = semverParts(latest)
  if (!currentParts || !latestParts) return false
  return compareSemver(latestParts, currentParts) > 0
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
