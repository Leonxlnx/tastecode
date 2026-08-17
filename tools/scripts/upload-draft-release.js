import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertCommitSha,
  assertReleaseTag,
  RELEASE_TAG,
  RELEASE_VERSION,
  releaseAssets,
  verifyReleaseDirectory,
} from './release-manifest.js'

function releaseDescription() {
  return 'Automated unsigned release proof. Keep this release in draft until clean-machine QA, signing decisions, updater validation, and final checksum review are complete.'
}

export async function uploadDraftRelease({
  releaseDirectory,
  token,
  repository,
  targetCommit,
  tag = RELEASE_TAG,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!token || !repository || !targetCommit) {
    throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA are required')
  }

  assertCommitSha(targetCommit)
  assertReleaseTag(tag)

  const repositoryParts = repository.split('/')
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !part)) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`)
  }

  const [owner, repo] = repositoryParts
  const resolvedDirectory = path.resolve(releaseDirectory)
  const desiredRelease = {
    target_commitish: targetCommit,
    name: `TasteCode ${RELEASE_VERSION}`,
    body: releaseDescription(),
    draft: true,
    prerelease: true,
  }
  const expectedNames = await verifyReleaseDirectory(resolvedDirectory, {
    platform: 'all',
    exact: true,
  })
  const expectedSet = new Set(expectedNames)
  const localSizes = new Map()

  for (const name of expectedNames) {
    localSizes.set(name, (await stat(path.join(resolvedDirectory, name))).size)
  }

  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }

  async function apiRequest(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: { ...apiHeaders, ...options.headers },
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000)
      const error = new Error(
        `${options.method ?? 'GET'} ${url} failed: ${response.status} ${detail}`,
      )
      error.status = response.status
      throw error
    }

    return response
  }

  const mainRefResponse = await apiRequest(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`,
  )
  const mainRef = await mainRefResponse.json()
  if (mainRef.object?.sha !== targetCommit) {
    throw new Error(`Approved release commit ${targetCommit} is no longer the current main commit`)
  }

  async function listReleasesForTag() {
    const matches = []

    for (let page = 1; ; page += 1) {
      const response = await apiRequest(
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
      )
      const releases = await response.json()
      matches.push(...releases.filter((release) => release.tag_name === tag))
      if (releases.length < 100) break
    }

    if (matches.length > 1) {
      const details = matches
        .map((release) => `#${release.id} (${release.draft ? 'draft' : 'published'})`)
        .join(', ')
      throw new Error(
        `Multiple releases use tag ${tag}: ${details}. Delete duplicate drafts before uploading.`,
      )
    }

    return matches[0] ?? null
  }

  function assertMutableDraft(release) {
    if (!release.draft) throw new Error(`Refusing to modify non-draft release ${tag}`)
  }

  async function confirmUniqueCreatedRelease(createdId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const confirmed = await listReleasesForTag()
      if (confirmed) {
        if (confirmed.id !== createdId) {
          throw new Error(`Release ${tag} changed identity during creation`)
        }
        assertMutableDraft(confirmed)
        return confirmed
      }
      await wait(250 * 2 ** attempt)
    }
    throw new Error(`Could not confirm unique draft release ${tag}`)
  }

  async function getOrCreateDraft() {
    const existing = await listReleasesForTag()
    if (existing) {
      // Published releases are immutable. This check intentionally precedes every PATCH/DELETE.
      assertMutableDraft(existing)
      return existing
    }

    try {
      const response = await apiRequest(`https://api.github.com/repos/${owner}/${repo}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: tag,
          ...desiredRelease,
        }),
      })
      const created = await response.json()
      assertMutableDraft(created)
      return confirmUniqueCreatedRelease(created.id)
    } catch (error) {
      if (error.status !== 422) throw error
      await wait(500)
      const racedRelease = await listReleasesForTag()
      if (!racedRelease) throw error
      assertMutableDraft(racedRelease)
      return racedRelease
    }
  }

  let release = await getOrCreateDraft()
  assertMutableDraft(release)

  const needsReleaseUpdate = Object.entries(desiredRelease).some(
    ([key, value]) => release[key] !== value,
  )
  if (needsReleaseUpdate) {
    const response = await apiRequest(
      `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(desiredRelease),
      },
    )
    release = await response.json()
    assertMutableDraft(release)
  }

  for (const [key, value] of Object.entries(desiredRelease)) {
    if (release[key] !== value) {
      throw new Error(`Draft release ${key} did not reconcile to the approved value`)
    }
  }

  async function listAssets() {
    const assets = []
    for (let page = 1; ; page += 1) {
      const response = await apiRequest(
        `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`,
      )
      const pageAssets = await response.json()
      assets.push(...pageAssets)
      if (pageAssets.length < 100) break
    }
    return assets
  }

  async function deleteAsset(asset) {
    try {
      await apiRequest(
        `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      if (error.status !== 404) throw error
    }
  }

  const currentAssets = await listAssets()
  for (const asset of currentAssets) {
    await deleteAsset(asset)
    console.log(
      `${expectedSet.has(asset.name) ? 'Replacing' : 'Removing'} draft asset ${asset.name}`,
    )
  }

  for (const name of expectedNames) {
    const filePath = path.join(resolvedDirectory, name)
    const fileSize = localSizes.get(name)
    await apiRequest(
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileSize),
        },
        body: createReadStream(filePath),
        duplex: 'half',
      },
    )
    console.log(`Uploaded ${name} (${fileSize} bytes)`)
  }

  const finalAssets = await listAssets()
  const finalNames = finalAssets.map((asset) => asset.name).sort()
  if (JSON.stringify(finalNames) !== JSON.stringify(releaseAssets('all'))) {
    throw new Error(`Draft release asset reconciliation failed: ${finalNames.join(', ')}`)
  }

  for (const asset of finalAssets) {
    if (asset.size !== localSizes.get(asset.name)) {
      throw new Error(`Draft release asset size mismatch for ${asset.name}`)
    }
  }

  return { release, assets: finalAssets }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  await uploadDraftRelease({
    releaseDirectory: process.argv[2] ?? 'release',
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    targetCommit: process.env.GITHUB_SHA,
    tag: process.env.RELEASE_TAG ?? RELEASE_TAG,
  })
}
