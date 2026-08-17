import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const releaseDirectory = path.resolve(process.argv[2] ?? 'release')
const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const targetCommit = process.env.GITHUB_SHA
const tag = process.env.RELEASE_TAG ?? 'v0.1.0-beta.1'
const releaseExtensions = new Set(['.exe', '.dmg', '.zip', '.blockmap'])
const internalAssetNames = new Set(['builder-debug.yml', 'builder-effective-config.yaml'])

if (!token || !repository || !targetCommit) {
  throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA are required')
}

const [owner, repo] = repository.split('/')

if (!owner || !repo) {
  throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`)
}

const apiHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
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

async function findRelease() {
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

async function getOrCreateRelease() {
  const existing = await findRelease()
  if (existing) {
    const response = await apiRequest(
      `https://api.github.com/repos/${owner}/${repo}/releases/${existing.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_commitish: targetCommit }),
      },
    )
    return response.json()
  }

  try {
    const response = await apiRequest(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: targetCommit,
        name: 'TasteCode 0.1.0 beta 1',
        body: 'Automated unsigned release proof. Keep this release in draft until clean-machine QA, signing decisions, updater validation, and final checksum review are complete.',
        draft: true,
        prerelease: true,
      }),
    })
    return response.json()
  } catch (error) {
    if (error.status !== 422) throw error
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const racedRelease = await findRelease()
    if (racedRelease) return racedRelease
    throw error
  }
}

const release = await getOrCreateRelease()

if (!release.draft) {
  throw new Error(`Refusing to modify non-draft release ${tag}`)
}

const assetResponse = await apiRequest(
  `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`,
)
const currentAssets = await assetResponse.json()
const currentByName = new Map(currentAssets.map((asset) => [asset.name, asset]))

async function deleteAsset(asset) {
  try {
    await apiRequest(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
      method: 'DELETE',
    })
  } catch (error) {
    if (error.status !== 404) throw error
  }
}

function isReleaseAsset(name) {
  if (name === 'beta.yml' || name === 'beta-mac.yml') return true
  if (/^SHA256SUMS-[A-Za-z0-9._-]+\.txt$/.test(name)) return true
  return name.startsWith('TasteCode-') && releaseExtensions.has(path.extname(name))
}

for (const name of internalAssetNames) {
  const internalAsset = currentByName.get(name)
  if (internalAsset) {
    await deleteAsset(internalAsset)
    console.log(`Removed internal asset ${name}`)
  }
}

for (const entry of (await readdir(releaseDirectory)).sort()) {
  const filePath = path.join(releaseDirectory, entry)
  const fileStat = await stat(filePath)

  if (!fileStat.isFile() || !isReleaseAsset(entry)) continue

  const existingAsset = currentByName.get(entry)
  if (existingAsset) {
    await deleteAsset(existingAsset)
  }

  await apiRequest(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(entry)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(fileStat.size),
      },
      body: createReadStream(filePath),
      duplex: 'half',
    },
  )

  console.log(`Uploaded ${entry} (${fileStat.size} bytes)`)
}
