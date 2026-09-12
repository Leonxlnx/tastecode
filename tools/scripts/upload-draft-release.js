import path from 'node:path'
import {
  assertCommitSha,
  hashFile,
  isMain,
  openRegularFile,
  releaseConfig,
  verifyReleaseDirectory,
} from './release-manifest.js'
import { verifyReleaseCheckout } from './verify-release-input.js'

export function draftDescription(approvedSha, config = releaseConfig) {
  return `Release artifact proof\n\nCommit: ${approvedSha}\nConfiguration: ${config.configSha256}\n\nUnsigned packaging proof only. Signing, notarization, clean-machine product QA, and updater proof are separate release gates. Keep this release in draft.`
}

// This writer never publishes, retargets, deletes, or replaces anything. The workflow serializes
// writers repository-wide. State is checked again before each upload because humans can also edit drafts.
export async function uploadDraftRelease({
  releaseDirectory,
  token,
  repository,
  approvedSha,
  uploadApproval,
  config = releaseConfig,
  fetchImpl = fetch,
}) {
  assertCommitSha(approvedSha)
  if (uploadApproval !== approvedSha)
    throw new Error('Draft upload requires explicit approval for this exact SHA')
  if (!token || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository ?? ''))
    throw new Error('A token and valid owner/repository are required')
  const directory = path.resolve(releaseDirectory)
  const names = await verifyReleaseDirectory(directory, { approvedSha, config })
  const local = new Map()
  for (const name of names) {
    const handle = await openRegularFile(path.join(directory, name))
    const size = (await handle.stat()).size
    await handle.close()
    local.set(name, { size, digest: `sha256:${await hashFile(path.join(directory, name))}` })
  }
  const base = `https://api.github.com/repos/${repository}`
  const tag = config.tag
  const desired = {
    tag_name: tag,
    target_commitish: approvedSha,
    name: `${config.productName} ${config.version} — packaging proof`,
    body: draftDescription(approvedSha, config),
    draft: true,
    prerelease: config.prerelease,
  }

  async function request(url, options = {}, allowMissing = false) {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(5 * 60 * 1000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    })
    if (allowMissing && response.status === 404) return null
    if (!response.ok) {
      await response.body?.cancel()
      // API error bodies can reflect private input. Never copy them or credentials into CI logs.
      throw new Error(
        `GitHub ${options.method ?? 'GET'} failed with HTTP ${response.status}; the draft was not published and no existing assets were removed`,
      )
    }
    return response.json()
  }

  async function list(url) {
    const rows = []
    for (let page = 1; page <= 100; page += 1) {
      const values = await request(`${url}?per_page=100&page=${page}`)
      if (!Array.isArray(values)) throw new Error('GitHub returned an invalid list')
      rows.push(...values)
      if (values.length < 100) return rows
    }
    throw new Error('GitHub pagination exceeded the safe release lookup limit')
  }

  async function verifyRefs() {
    const main = await request(`${base}/git/ref/heads/main`)
    if (main.object?.type !== 'commit' || main.object.sha !== approvedSha)
      throw new Error('The approved release commit is no longer the current main commit')
    const tagRef = await request(`${base}/git/ref/tags/${encodeURIComponent(tag)}`, {}, true)
    if (!tagRef) return
    let object = tagRef.object
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
      assertCommitSha(object.sha)
      object = (await request(`${base}/git/tags/${object.sha}`)).object
    }
    if (object?.type !== 'commit' || object.sha !== approvedSha)
      throw new Error('The existing release tag does not point to the approved commit')
  }

  function assertDraft(release) {
    if (!Number.isSafeInteger(release?.id) || release.id <= 0)
      throw new Error('GitHub returned an invalid release identity')
    if (release.draft !== true) throw new Error('Refusing to modify a published release')
    if (Object.entries(desired).some(([key, value]) => release[key] !== value))
      throw new Error(
        'Existing draft does not match this approved commit and proof; it was left untouched',
      )
  }

  async function uniqueDraft() {
    const matches = (await list(`${base}/releases`)).filter((release) => release.tag_name === tag)
    if (matches.length > 1)
      throw new Error('Multiple releases use this tag; all drafts were left untouched')
    if (matches.length === 0) return null
    const release = await request(`${base}/releases/${matches[0].id}`)
    assertDraft(release)
    return release
  }

  function verifyAsset(asset) {
    const expected = local.get(asset.name)
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !expected ||
      asset.state !== 'uploaded' ||
      asset.size !== expected.size ||
      asset.digest !== expected.digest
    )
      throw new Error(
        'Remote draft asset does not match the exact local SHA-256 manifest; nothing was replaced',
      )
  }

  async function assetsFor(id) {
    const assets = await list(`${base}/releases/${id}/assets`)
    const seen = new Set()
    for (const asset of assets) {
      verifyAsset(asset)
      if (seen.has(asset.name)) throw new Error('Duplicate remote draft asset name')
      seen.add(asset.name)
    }
    return assets
  }

  await verifyRefs()
  let release = await uniqueDraft()
  if (!release) {
    await verifyRefs()
    // A failed/uncertain POST is never retried. A later explicit run can resume a verified draft.
    const created = await request(`${base}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(desired),
    })
    assertDraft(created)
    release = await uniqueDraft()
    if (!release || release.id !== created.id)
      throw new Error('Draft identity changed during creation; no assets were uploaded')
  }
  const id = release.id
  for (const name of names) {
    await verifyRefs()
    release = await uniqueDraft()
    if (release?.id !== id) throw new Error('Draft identity changed during upload')
    const existing = await assetsFor(id)
    if (existing.some((asset) => asset.name === name)) continue
    const expected = local.get(name)
    const filePath = path.join(directory, name)
    if (`sha256:${await hashFile(filePath)}` !== expected.digest)
      throw new Error('Local release asset changed before upload')
    const handle = await openRegularFile(filePath)
    const stream = handle.createReadStream({ autoClose: false })
    try {
      const asset = await request(
        `https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(expected.size),
          },
          body: stream,
          duplex: 'half',
        },
      )
      if (asset.name !== name) throw new Error('GitHub changed the uploaded asset name')
      verifyAsset(asset)
    } finally {
      stream.destroy()
      await handle.close()
    }
  }
  await verifyRefs()
  release = await uniqueDraft()
  if (release?.id !== id) throw new Error('Draft identity changed before final verification')
  const assets = await assetsFor(id)
  if (JSON.stringify(assets.map((asset) => asset.name).sort()) !== JSON.stringify(names))
    throw new Error('Draft is incomplete; retry only after inspecting the exact draft')
  await verifyReleaseDirectory(directory, { approvedSha, config })
  return { release, assets }
}

if (isMain(import.meta.url)) {
  const approvedSha = verifyReleaseCheckout()
  const result = await uploadDraftRelease({
    releaseDirectory: process.argv[2] ?? 'release-final',
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    approvedSha,
    uploadApproval: process.env.RELEASE_UPLOAD_APPROVAL,
  })
  console.log(
    `Verified draft #${result.release.id}: ${result.assets.length} assets. Packaging proof only; nothing published.`,
  )
}
