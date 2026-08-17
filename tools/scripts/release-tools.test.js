import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateReleaseChecksums } from './release-checksums.js'
import {
  RELEASE_TAG,
  RELEASE_VERSION,
  checksumPayloadAssets,
  releaseAssets,
  verifyReleaseDirectory,
} from './release-manifest.js'
import { stageReleaseAssets } from './stage-release-assets.js'
import { uploadDraftRelease } from './upload-draft-release.js'
import { verifyReleaseInput } from './verify-release-input.js'

const APPROVED_SHA = '1234567890abcdef1234567890abcdef12345678'

async function createReleaseFixture(platform = 'all') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-release-'))
  const platforms = platform === 'all' ? ['windows', 'macos'] : [platform]

  for (const currentPlatform of platforms) {
    for (const name of checksumPayloadAssets(currentPlatform)) {
      let content = `fixture:${name}\n`
      if (name === 'beta.yml') {
        content = `version: ${RELEASE_VERSION}\nfiles:\n  - url: TasteCode-${RELEASE_VERSION}-win-x64.exe\npath: TasteCode-${RELEASE_VERSION}-win-x64.exe\n`
      } else if (name === 'beta-mac.yml') {
        content = `version: ${RELEASE_VERSION}\nfiles:\n  - url: TasteCode-${RELEASE_VERSION}-mac-arm64.zip\npath: TasteCode-${RELEASE_VERSION}-mac-arm64.zip\n`
      }
      await writeFile(path.join(directory, name), content, 'utf8')
    }
    await generateReleaseChecksums(directory, currentPlatform)
  }

  return directory
}

function jsonResponse(value, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: status === 204 ? undefined : { 'Content-Type': 'application/json' },
  })
}

function createGithubMock({
  releases = [],
  assets = [],
  createStatus = 201,
  releasesAfterCreateFailure,
  mainSha = APPROVED_SHA,
} = {}) {
  const state = {
    releases: structuredClone(releases),
    assets: structuredClone(assets),
    mutations: [],
    calls: [],
    nextReleaseId: 100,
    nextAssetId: 1_000,
  }

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url)
    const method = options.method ?? 'GET'
    state.calls.push({ method, url: parsed.toString() })

    if (parsed.pathname === '/repos/test/tastecode/git/ref/heads/main' && method === 'GET') {
      return jsonResponse({ object: { sha: mainSha } })
    }

    const releaseListMatch = parsed.pathname.match(/^\/repos\/test\/tastecode\/releases$/)
    if (releaseListMatch && method === 'GET') {
      const page = Number(parsed.searchParams.get('page') ?? 1)
      return jsonResponse(page === 1 ? state.releases : [])
    }

    if (releaseListMatch && method === 'POST') {
      state.mutations.push({ method, path: parsed.pathname })
      if (createStatus !== 201) {
        if (releasesAfterCreateFailure) {
          state.releases = structuredClone(releasesAfterCreateFailure)
        }
        return jsonResponse({ message: 'create race' }, createStatus)
      }
      const body = JSON.parse(options.body)
      const release = { id: state.nextReleaseId++, ...body }
      state.releases.push(release)
      return jsonResponse(release, 201)
    }

    const releaseMatch = parsed.pathname.match(/^\/repos\/test\/tastecode\/releases\/(\d+)$/)
    if (releaseMatch && method === 'PATCH') {
      state.mutations.push({ method, path: parsed.pathname })
      const release = state.releases.find((item) => item.id === Number(releaseMatch[1]))
      Object.assign(release, JSON.parse(options.body))
      return jsonResponse(release)
    }

    const assetListMatch = parsed.pathname.match(
      /^\/repos\/test\/tastecode\/releases\/(\d+)\/assets$/,
    )
    if (assetListMatch && method === 'GET') {
      const page = Number(parsed.searchParams.get('page') ?? 1)
      return jsonResponse(page === 1 ? state.assets : [])
    }

    const assetDeleteMatch = parsed.pathname.match(
      /^\/repos\/test\/tastecode\/releases\/assets\/(\d+)$/,
    )
    if (assetDeleteMatch && method === 'DELETE') {
      state.mutations.push({ method, path: parsed.pathname })
      state.assets = state.assets.filter((asset) => asset.id !== Number(assetDeleteMatch[1]))
      return jsonResponse(null, 204)
    }

    const uploadMatch = parsed.pathname.match(/^\/repos\/test\/tastecode\/releases\/(\d+)\/assets$/)
    if (parsed.hostname === 'uploads.github.com' && uploadMatch && method === 'POST') {
      state.mutations.push({ method, path: parsed.pathname })
      for await (const _chunk of options.body) {
        // Consume the file stream so fixtures do not leave open descriptors.
      }
      const asset = {
        id: state.nextAssetId++,
        name: parsed.searchParams.get('name'),
        size: Number(options.headers['Content-Length']),
      }
      state.assets.push(asset)
      return jsonResponse(asset, 201)
    }

    throw new Error(`Unhandled mock request: ${method} ${parsed}`)
  }

  return { state, fetchImpl }
}

async function runUpload(directory, mock) {
  return uploadDraftRelease({
    releaseDirectory: directory,
    token: 'fixture-token',
    repository: 'test/tastecode',
    targetCommit: APPROVED_SHA,
    tag: RELEASE_TAG,
    fetchImpl: mock.fetchImpl,
    wait: async () => {},
  })
}

test('release manifests and platform staging are exact and checksum-backed', async () => {
  const source = await createReleaseFixture('all')
  assert.deepEqual(await verifyReleaseDirectory(source), releaseAssets('all'))

  const desktopPackage = JSON.parse(
    await readFile(path.resolve('apps/desktop/package.json'), 'utf8'),
  )
  assert.equal(desktopPackage.version, RELEASE_VERSION)
  assert.equal(desktopPackage.build.executableName, 'TasteCode')

  const staged = await mkdtemp(path.join(os.tmpdir(), 'tastecode-stage-'))
  await stageReleaseAssets(source, staged, 'windows')
  assert.deepEqual((await readdir(staged)).sort(), releaseAssets('windows'))
  await verifyReleaseDirectory(staged, { platform: 'windows' })

  await writeFile(path.join(staged, 'builder-debug.yml'), 'internal\n', 'utf8')
  await assert.rejects(
    verifyReleaseDirectory(staged, { platform: 'windows' }),
    /must contain exactly/,
  )
})

test('stale, wrong-version, and empty manifests fail before any GitHub API call', async (t) => {
  await t.test('stale extra asset', async () => {
    const directory = await createReleaseFixture('all')
    await writeFile(path.join(directory, 'TasteCode-0.0.0-win-x64.exe'), 'stale\n', 'utf8')
    const mock = createGithubMock()
    await assert.rejects(runUpload(directory, mock), /must contain exactly/)
    assert.equal(mock.state.calls.length, 0)
  })

  await t.test('wrong updater version', async () => {
    const directory = await createReleaseFixture('all')
    const metadata = path.join(directory, 'beta.yml')
    const text = await readFile(metadata, 'utf8')
    await writeFile(metadata, text.replace(RELEASE_VERSION, '0.0.0'), 'utf8')
    const mock = createGithubMock()
    await assert.rejects(runUpload(directory, mock), /must declare version/)
    assert.equal(mock.state.calls.length, 0)
  })

  await t.test('empty expected asset', async () => {
    const directory = await createReleaseFixture('all')
    await writeFile(path.join(directory, `TasteCode-${RELEASE_VERSION}-mac-arm64.dmg`), '')
    const mock = createGithubMock()
    await assert.rejects(runUpload(directory, mock), /is empty/)
    assert.equal(mock.state.calls.length, 0)
  })

  await t.test('wrong architecture', async () => {
    const directory = await createReleaseFixture('all')
    await writeFile(
      path.join(directory, `TasteCode-${RELEASE_VERSION}-win-arm64.exe`),
      'wrong architecture\n',
      'utf8',
    )
    const mock = createGithubMock()
    await assert.rejects(runUpload(directory, mock), /must contain exactly/)
    assert.equal(mock.state.calls.length, 0)
  })
})

test('published releases are rejected before PATCH, DELETE, or upload', async () => {
  const directory = await createReleaseFixture('all')
  const mock = createGithubMock({
    releases: [
      {
        id: 7,
        tag_name: RELEASE_TAG,
        draft: false,
        target_commitish: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
  })

  await assert.rejects(runUpload(directory, mock), /Refusing to modify non-draft release/)
  assert.deepEqual(mock.state.mutations, [])
})

test('an approved commit that is no longer main is rejected before release mutation', async () => {
  const directory = await createReleaseFixture('all')
  const mock = createGithubMock({
    mainSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })

  await assert.rejects(runUpload(directory, mock), /is no longer the current main commit/)
  assert.deepEqual(mock.state.mutations, [])
})

test('duplicate drafts are rejected without mutating either draft', async () => {
  const directory = await createReleaseFixture('all')
  const mock = createGithubMock({
    releases: [
      {
        id: 7,
        tag_name: RELEASE_TAG,
        draft: true,
        target_commitish: APPROVED_SHA,
      },
      {
        id: 8,
        tag_name: RELEASE_TAG,
        draft: true,
        target_commitish: APPROVED_SHA,
      },
    ],
  })

  await assert.rejects(runUpload(directory, mock), /Multiple releases use tag/)
  assert.deepEqual(mock.state.mutations, [])
})

test('a concurrent-create race refuses duplicate drafts before asset mutation', async () => {
  const directory = await createReleaseFixture('all')
  const racedDrafts = [
    {
      id: 7,
      tag_name: RELEASE_TAG,
      draft: true,
      target_commitish: APPROVED_SHA,
    },
    {
      id: 8,
      tag_name: RELEASE_TAG,
      draft: true,
      target_commitish: APPROVED_SHA,
    },
  ]
  const mock = createGithubMock({
    createStatus: 422,
    releasesAfterCreateFailure: racedDrafts,
  })

  await assert.rejects(runUpload(directory, mock), /Multiple releases use tag/)
  assert.equal(mock.state.mutations.length, 1)
  assert.equal(mock.state.mutations[0].method, 'POST')
  assert.equal(mock.state.assets.length, 0)
})

test('one draft is retargeted and reconciled to the exact approved asset set', async () => {
  const directory = await createReleaseFixture('all')
  const mock = createGithubMock({
    releases: [
      {
        id: 7,
        tag_name: RELEASE_TAG,
        draft: true,
        target_commitish: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    assets: [
      { id: 20, name: 'builder-debug.yml', size: 8 },
      { id: 21, name: releaseAssets('all')[0], size: 1 },
    ],
  })

  const result = await runUpload(directory, mock)
  assert.equal(result.release.target_commitish, APPROVED_SHA)
  assert.deepEqual(mock.state.assets.map((asset) => asset.name).sort(), releaseAssets('all'))
  assert.equal(
    mock.state.assets.some((asset) => asset.name === 'builder-debug.yml'),
    false,
  )
  assert.equal(mock.state.mutations.filter((entry) => entry.method === 'PATCH').length, 1)
  assert.equal(mock.state.mutations.filter((entry) => entry.method === 'POST').length, 10)
})

test('a clean run creates and confirms exactly one private draft', async () => {
  const directory = await createReleaseFixture('all')
  const mock = createGithubMock()

  const result = await runUpload(directory, mock)
  assert.equal(mock.state.releases.length, 1)
  assert.equal(result.release.draft, true)
  assert.equal(result.release.prerelease, true)
  assert.equal(result.release.target_commitish, APPROVED_SHA)
  assert.deepEqual(mock.state.assets.map((asset) => asset.name).sort(), releaseAssets('all'))
  assert.equal(
    mock.state.mutations.filter(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/releases'),
    ).length,
    1,
  )
})

test('release input accepts only the exact selected main commit', () => {
  assert.equal(
    verifyReleaseInput({
      approvedSha: APPROVED_SHA,
      eventSha: APPROVED_SHA,
      eventRef: 'refs/heads/main',
    }),
    APPROVED_SHA,
  )
  assert.throws(
    () =>
      verifyReleaseInput({
        approvedSha: APPROVED_SHA,
        eventSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        eventRef: 'refs/heads/main',
      }),
    /must equal/,
  )
  assert.throws(
    () =>
      verifyReleaseInput({
        approvedSha: APPROVED_SHA,
        eventSha: APPROVED_SHA,
        eventRef: 'refs/heads/release',
      }),
    /must be dispatched from refs\/heads\/main/,
  )
})

test('workflow serializes concurrent dispatches and has exactly one write-capable uploader', async () => {
  const workflowPath = path.resolve('.github/workflows/release-artifact-proof.yml')
  const workflow = await readFile(workflowPath, 'utf8')
  const workflowHeader = workflow.split('\njobs:')[0]
  const packageSection = workflow.split('\n  package:')[1].split('\n  publish-draft:')[0]
  const publishSection = workflow.split('\n  publish-draft:')[1]

  assert.match(workflow, /group: release-artifact-proof-v0\.1\.0-beta\.1/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflowHeader, /permissions:\n  contents: read/)
  assert.doesNotMatch(workflowHeader, /contents: write/)
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1)
  assert.equal((workflow.match(/upload-draft-release\.js/g) ?? []).length, 1)
  assert.match(packageSection, /permissions:\n      contents: read/)
  assert.doesNotMatch(packageSection, /contents: write|GITHUB_TOKEN|upload-draft-release\.js/)
  assert.equal(
    (packageSection.match(/actions\/checkout@/g) ?? []).length,
    (packageSection.match(/persist-credentials: false/g) ?? []).length,
  )
  assert.match(publishSection, /needs: \[verify-input, package\]/)
  assert.match(publishSection, /permissions:\n      contents: write/)

  const uses = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1])
  assert.ok(uses.length > 0)
  for (const reference of uses) assert.match(reference, /^[a-f0-9]{40}$/)

  assert.equal(
    (workflow.match(/actions\/checkout@/g) ?? []).length,
    (workflow.match(/persist-credentials: false/g) ?? []).length,
  )
})
