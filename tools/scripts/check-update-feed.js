import { createRequire } from 'node:module'
import path from 'node:path'
import { desktopDirectory, isMain, releaseConfig } from './release-manifest.js'

const semver = createRequire(path.join(desktopDirectory, 'package.json'))('semver')

// Installed apps choose a release in two ways. Their code is already on users'
// machines, so a release that breaks either has to be caught before publishing.
export const generations = [
  { label: 'Beta 7 to 0.1.1', picks: 'the most recently published release' },
  { label: 'Later builds', picks: 'the highest published version' },
]

// The asset names and checks mirror the desktop GitHubReleaseProvider.
const installers = [
  { platform: 'macOS', target: 'mac', arch: 'arm64', extension: 'dmg' },
  { platform: 'Windows', target: 'win', arch: 'x64', extension: 'exe' },
]

function versionOf(tag) {
  const version = typeof tag === 'string' ? tag.replace(/^v/, '') : ''
  return semver.valid(version) === version ? version : undefined
}

function installerProblem(release, repository, installer) {
  const version = versionOf(release.tag_name)
  const name = `TasteCode-${version}-${installer.target}-${installer.arch}.${installer.extension}`
  const matches = (release.assets ?? []).filter((asset) => asset?.name === name)
  if (matches.length !== 1) return `missing ${name}`
  const asset = matches[0]
  const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`
  if (asset.state !== 'uploaded') return `${name} is still uploading`
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 4 * 1024 ** 3)
    return `${name} has an invalid size`
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) return `${name} has no SHA-256 digest`
  if (asset.browser_download_url !== url) return `${name} downloads from an unexpected URL`
  return undefined
}

/**
 * What each installed generation would take from `releases`, optionally after
 * publishing `draft` now. `failed` means that generation cannot update.
 */
export function updateFeedVerdicts(
  releases,
  { draft, repository = `${releaseConfig.publish.owner}/${releaseConfig.publish.repo}`, now } = {},
) {
  let rows = releases
  if (draft) {
    // A draft's assets live under download/untagged-<id>/ until publishing
    // moves them under the tag; anything else stays as it is and is checked.
    const untagged = new RegExp(
      `^https://github\\.com/${repository.replaceAll('.', '\\.')}/releases/download/untagged-[A-Za-z0-9]+/`,
    )
    const published = {
      ...draft,
      draft: false,
      published_at: (now ?? new Date()).toISOString(),
      assets: (draft.assets ?? []).map((asset) => ({
        ...asset,
        browser_download_url: asset.browser_download_url?.replace(
          untagged,
          `https://github.com/${repository}/releases/download/${encodeURIComponent(draft.tag_name)}/`,
        ),
      })),
    }
    rows = [published, ...releases.filter((release) => release.tag_name !== draft.tag_name)]
  }
  const published = rows.filter(
    (release) => !release.draft && release.published_at && versionOf(release.tag_name),
  )
  if (published.length === 0) throw new Error('No published TasteCode release was found.')
  const byDate = [...published].sort(
    (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
  )[0]
  const byVersion = [...published].sort((a, b) =>
    semver.rcompare(versionOf(a.tag_name), versionOf(b.tag_name)),
  )[0]
  return [byDate, byVersion].map((release, index) => {
    const problems = installers
      .map((installer) => installerProblem(release, repository, installer))
      .filter(Boolean)
    const notes = []
    if (index === 0 && release !== byVersion)
      notes.push(
        `${release.tag_name} is not the highest version; ${byVersion.tag_name} is. Publish the highest version last.`,
      )
    return {
      ...generations[index],
      tag: release.tag_name,
      failed: problems.length > 0,
      problems: [...problems, ...notes],
    }
  })
}

async function listReleases(repository, token) {
  const rows = []
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!response.ok) {
      await response.body?.cancel()
      // Error bodies can reflect request details; the status is enough.
      throw new Error(`GitHub release list failed with HTTP ${response.status}`)
    }
    const batch = await response.json()
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid release list')
    rows.push(...batch)
    if (batch.length < 100) return rows
  }
  throw new Error('GitHub release history exceeded the lookup limit')
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const draftTag = args[0] === '--draft' ? args[1] : undefined
  if (args.length > 0 && !draftTag)
    throw new Error('Usage: node check-update-feed.js [--draft <tag>]   (--draft needs GH_TOKEN)')
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (draftTag && !token) throw new Error('Reading a draft needs GH_TOKEN or GITHUB_TOKEN')
  const repository = `${releaseConfig.publish.owner}/${releaseConfig.publish.repo}`
  const releases = await listReleases(repository, draftTag ? token : undefined)
  const draft = draftTag
    ? releases.find((release) => release.tag_name === draftTag && release.draft)
    : undefined
  if (draftTag && !draft) throw new Error(`No draft release is tagged ${draftTag}`)
  const verdicts = updateFeedVerdicts(
    releases.filter((release) => !release.draft),
    { draft, repository },
  )
  console.log(draftTag ? `If ${draftTag} were published now:` : 'Public releases right now:')
  for (const verdict of verdicts) {
    console.log(
      `${verdict.failed ? 'FAIL' : 'ok  '} ${verdict.label} take ${verdict.tag} (${verdict.picks})`,
    )
    for (const problem of verdict.problems) console.log(`       ${problem}`)
  }
  if (verdicts.some((verdict) => verdict.failed)) process.exitCode = 1
}
