import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dump, load } from 'js-yaml'
import { generateReleaseChecksums } from './release-checksums.js'
import {
  assertAssetName,
  checksumPayloadAssets,
  createReleaseConfig,
  desktopDirectory,
  hashFile,
  parseMetadata,
  platformConfig,
  releaseAssets,
  releaseConfig,
  releasePayloadAssets,
  repositoryRoot,
  verifyReleaseDirectory,
  verifyReleasePayload,
} from './release-manifest.js'
import { stageReleaseAssets } from './stage-release-assets.js'
import { draftDescription, uploadDraftRelease } from './upload-draft-release.js'
import { verifyReleaseInput } from './verify-release-input.js'
import {
  assertInstallerProofHost,
  packagingAsar,
  verifyBundledDesignReferences,
  verifyPackagedResources,
} from './verify-release-assets.js'

const approvedSha = '1234567890abcdef1234567890abcdef12345678'
const otherSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-tools-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function fixture(t, { platform = 'all', config = releaseConfig } = {}) {
  const directory = await temporary(t)
  for (const current of platform === 'all' ? ['windows', 'macos'] : [platform]) {
    const detail = platformConfig(current, config)
    for (const name of releasePayloadAssets(current, config).filter(
      (name) => name !== detail.metadata,
    )) {
      await writeFile(path.join(directory, name), `fixture:${name}\n`)
    }
    const files = []
    for (const name of detail.artifacts) {
      const content = await readFile(path.join(directory, name))
      files.push({
        url: name,
        sha512: createHash('sha512').update(content).digest('base64'),
        size: content.length,
      })
    }
    await writeFile(
      path.join(directory, detail.metadata),
      dump({
        version: config.version,
        files,
        path: detail.primaryArtifact,
        sha512: files[0].sha512,
        releaseDate: '2026-09-09T00:00:00.000Z',
      }),
    )
    await generateReleaseChecksums(directory, current, { approvedSha, config })
  }
  return directory
}

async function changeMetadata(directory, change, platform = 'windows', config = releaseConfig) {
  const file = path.join(directory, platformConfig(platform, config).metadata)
  const value = load(await readFile(file, 'utf8'))
  change(value)
  await writeFile(file, dump(value, { noRefs: true }))
}

function draft(id = 7, config = releaseConfig) {
  return {
    id,
    tag_name: config.tag,
    target_commitish: approvedSha,
    name: `${config.productName} ${config.version} — packaging proof`,
    body: draftDescription(approvedSha, config),
    draft: true,
    prerelease: config.prerelease,
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function github({
  releases = [],
  assets = [],
  beforeRequest,
  mainSha = approvedSha,
  tagObject = null,
} = {}) {
  const state = {
    releases: structuredClone(releases),
    assets: structuredClone(assets),
    calls: [],
    mutations: [],
    mainSha,
    tagObject,
    nextAsset: 1000,
  }
  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url)
    const method = options.method ?? 'GET'
    const request = { url: parsed, method, options, state }
    state.calls.push({ method, url })
    if (method !== 'GET') state.mutations.push({ method, url })
    const intercepted = await beforeRequest?.(request)
    if (intercepted) return intercepted
    if (parsed.pathname.endsWith('/git/ref/heads/main'))
      return json({ object: { type: 'commit', sha: state.mainSha } })
    if (parsed.pathname.includes('/git/ref/tags/'))
      return state.tagObject ? json({ object: state.tagObject }) : json({}, 404)
    if (parsed.pathname === '/repos/test/tastecode/releases') {
      if (method === 'POST') {
        const created = { id: 100, ...JSON.parse(options.body) }
        state.releases.push(created)
        return json(created, 201)
      }
      const offset = (Number(parsed.searchParams.get('page')) - 1) * 100
      return json(state.releases.slice(offset, offset + 100))
    }
    if (/\/releases\/\d+$/.test(parsed.pathname) && method === 'GET') {
      const value = state.releases.find(
        (entry) => String(entry.id) === parsed.pathname.split('/').at(-1),
      )
      return value ? json(value) : json({}, 404)
    }
    if (/\/releases\/\d+\/assets$/.test(parsed.pathname)) {
      if (method === 'GET') {
        const offset = (Number(parsed.searchParams.get('page')) - 1) * 100
        return json(state.assets.slice(offset, offset + 100))
      }
      assert.equal(parsed.hostname, 'uploads.github.com')
      const chunks = []
      for await (const chunk of options.body) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      assert.equal(bytes.length, Number(options.headers['Content-Length']))
      const asset = {
        id: state.nextAsset++,
        name: parsed.searchParams.get('name'),
        size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        state: 'uploaded',
      }
      state.assets.push(asset)
      return json(asset, 201)
    }
    throw new Error(`Unhandled mock request: ${method} ${parsed}`)
  }
  return { state, fetchImpl }
}

function upload(directory, mock, overrides = {}) {
  return uploadDraftRelease({
    releaseDirectory: directory,
    token: 'test-only-placeholder',
    repository: 'test/tastecode',
    approvedSha,
    uploadApproval: approvedSha,
    fetchImpl: mock.fetchImpl,
    ...overrides,
  })
}

test('platform assets match current packaging config and staged files are exact', async (t) => {
  const source = await fixture(t)
  assert.deepEqual(await verifyReleaseDirectory(source, { approvedSha }), releaseAssets())
  await writeFile(path.join(source, 'builder-debug.yml'), 'internal diagnostics')
  await assert.rejects(verifyReleaseDirectory(source, { approvedSha }), /exactly/)
  const destination = path.join(await temporary(t), 'stage')
  await stageReleaseAssets(source, destination, 'windows', { approvedSha })
  assert.deepEqual((await readdir(destination)).sort(), releaseAssets('windows'))
  await assert.rejects(
    stageReleaseAssets(source, destination, 'windows', { approvedSha }),
    /EEXIST/,
  )
  assert.deepEqual((await readdir(destination)).sort(), releaseAssets('windows'))
  await assert.rejects(
    stageReleaseAssets(source, source, 'windows', { approvedSha }),
    /must differ/,
  )
})

test('version, channel, product, and artifact names come from package config', async (t) => {
  const desktop = JSON.parse(await readFile(path.join(desktopDirectory, 'package.json'), 'utf8'))
  desktop.version = '2.3.4'
  desktop.productName = 'Example App'
  desktop.build.artifactName = '${productName}-${version}-${os}-${arch}.${ext}'
  const config = createReleaseConfig(desktop)
  assert.equal(config.channel, 'latest')
  assert.equal(config.updaterChannel, undefined)
  assert.equal(config.tag, 'v2.3.4')
  assert.equal(config.prerelease, false)
  assert.equal(config.platforms.macos.metadata, 'latest-mac.yml')
  assert.equal(config.platforms.windows.primaryArtifact, 'Example App-2.3.4-win-x64.exe')
  const directory = await fixture(t, { config })
  assert.deepEqual(
    await verifyReleaseDirectory(directory, { approvedSha, config }),
    releaseAssets('all', config),
  )
  desktop.build.publish[0].channel = 'candidate'
  assert.equal(createReleaseConfig(desktop).channel, 'candidate')
  delete desktop.build.publish[0].channel
  desktop.version = '2.3.4-rc-internal.2'
  assert.equal(createReleaseConfig(desktop).channel, 'rc-internal')
  desktop.build.mac.detectUpdateChannel = false
  assert.throws(() => createReleaseConfig(desktop), /per-platform/)
  delete desktop.build.mac.detectUpdateChannel
  desktop.build.artifactName = '${env.SECRET}.${ext}'
  assert.throws(() => createReleaseConfig(desktop), /Unsupported artifactName/)
})

test('unsafe cross-platform filenames are rejected', () => {
  for (const name of [
    '../secret',
    '..\\secret',
    'C:\\secret',
    'file:stream',
    'a\nb',
    'a\rb',
    'a%2fb',
    'https://bad/a',
    'a?token=x',
    'a#x',
    'a.',
    'a ',
    'NUL.exe',
    'COM1.txt',
    '',
    null,
  ]) {
    assert.throws(() => assertAssetName(name), /safe, flat filenames/, String(name))
  }
  assert.equal(assertAssetName('Example App-1.0.0+1.exe'), 'Example App-1.0.0+1.exe')
})

test('untrusted updater metadata cannot redirect, omit, or corrupt artifacts', async (t) => {
  const mutations = [
    [
      'version',
      (value) => {
        value.version = '0.0.0'
      },
      /version/,
    ],
    [
      'URL traversal',
      (value) => {
        value.files[0].url = '..\\secret.exe'
      },
      /safe, flat/,
    ],
    [
      'absolute URL',
      (value) => {
        value.files[0].url = 'https://bad.example/a.exe'
      },
      /safe, flat/,
    ],
    [
      'unapproved file',
      (value) => {
        value.files[0].url = 'other.exe'
      },
      /unexpected/,
    ],
    [
      'false size',
      (value) => {
        value.files[0].size += 1
      },
      /size mismatch/,
    ],
    [
      'false digest',
      (value) => {
        value.files[0].sha512 = 'bad'
      },
      /SHA-512 mismatch/,
    ],
    [
      'missing primary',
      (value) => {
        delete value.path
      },
      /primary/,
    ],
    [
      'wrong legacy digest',
      (value) => {
        value.sha512 = 'bad'
      },
      /primary/,
    ],
    [
      'unknown packages',
      (value) => {
        value.packages = { x64: { path: 'bad.exe' } }
      },
      /fields/,
    ],
    [
      'invalid date',
      (value) => {
        value.releaseDate = 'bad'
      },
      /releaseDate/,
    ],
    [
      'extra file',
      (value) => {
        value.files.push(value.files[0])
      },
      /exactly/,
    ],
    [
      'unsafe size type',
      (value) => {
        value.files[0].size = String(value.files[0].size)
      },
      /size mismatch/,
    ],
    [
      'negative block size',
      (value) => {
        value.files[0].blockMapSize = -1
      },
      /blockMapSize/,
    ],
  ]
  for (const [name, mutate, expected] of mutations) {
    await t.test(name, async (subtest) => {
      const directory = await fixture(subtest, { platform: 'windows' })
      await changeMetadata(directory, mutate)
      await assert.rejects(verifyReleasePayload(directory, 'windows'), expected)
    })
  }
  const directory = await fixture(t, { platform: 'macos' })
  await changeMetadata(
    directory,
    (value) => {
      value.files[1] = value.files[0]
    },
    'macos',
  )
  await assert.rejects(verifyReleasePayload(directory, 'macos'), /duplicate/)
})

test('YAML duplicate keys, anchors, tags, and oversized metadata fail closed', async (t) => {
  assert.throws(() => parseMetadata('version: 1\nversion: 2\n'), /duplicated mapping key/)
  assert.throws(() => parseMetadata('files: &files []\npath: *files\n'), /anchors or aliases/)
  assert.throws(() => parseMetadata('files: !!js/function function() {}'), /unknown tag/)
  const directory = await fixture(t, { platform: 'windows' })
  await writeFile(
    path.join(directory, releaseConfig.platforms.windows.metadata),
    'a'.repeat(128 * 1024 + 1),
  )
  await assert.rejects(verifyReleasePayload(directory, 'windows'), /exceeds/)
})

test('checksum and provenance tampering fail before any API request', async (t) => {
  const detail = releaseConfig.platforms.windows
  const cases = [
    [
      'stale commit',
      detail.provenance,
      (text) => text.replace(approvedSha, otherSha),
      /provenance/,
    ],
    [
      'changed config',
      detail.provenance,
      (text) => text.replace(releaseConfig.configSha256, '0'.repeat(64)),
      /provenance/,
    ],
    [
      'duplicate checksum',
      detail.checksums,
      (text) => `${text}${text.split('\n')[0]}\n`,
      /Duplicate/,
    ],
    [
      'bad checksum',
      detail.checksums,
      (text) => text.replace(/^[a-f0-9]{64}/, '0'.repeat(64)),
      /Checksum mismatch/,
    ],
    [
      'missing checksum',
      detail.checksums,
      (text) => text.split('\n').slice(1).join('\n'),
      /exactly/,
    ],
    [
      'path in checksum',
      detail.checksums,
      (text) => text.replace(/ {2}.+/, '  ..\\outside'),
      /safe, flat/,
    ],
  ]
  for (const [name, file, change, expected] of cases) {
    await t.test(name, async (subtest) => {
      const directory = await fixture(subtest)
      const target = path.join(directory, file)
      await writeFile(target, change(await readFile(target, 'utf8')))
      const mock = github()
      await assert.rejects(upload(directory, mock), expected)
      assert.equal(mock.state.calls.length, 0)
    })
  }
})

test('missing, empty, linked, and extra directory assets are not accepted', async (t) => {
  const directory = await fixture(t)
  const name = releaseConfig.platforms.windows.primaryArtifact
  const file = path.join(directory, name)
  const content = await readFile(file)
  await writeFile(file, '')
  await assert.rejects(verifyReleaseDirectory(directory, { approvedSha }), /nonempty/)
  await writeFile(file, content)
  const linked = path.join(await temporary(t), 'hardlink')
  await link(file, linked)
  await assert.rejects(verifyReleaseDirectory(directory, { approvedSha }), /without links/)
  await rm(linked)
  await mkdir(path.join(directory, 'extra-directory'))
  await assert.rejects(verifyReleaseDirectory(directory, { approvedSha }), /exactly/)
  await rm(path.join(directory, 'extra-directory'), { recursive: true })
  await rm(file)
  await assert.rejects(verifyReleaseDirectory(directory, { approvedSha }), /exactly/)
})

test('symlinked assets and staging destinations are refused', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Windows symlinks require Developer Mode; hardlink refusal is tested on every OS')
  const directory = await fixture(t, { platform: 'windows' })
  const name = releaseConfig.platforms.windows.primaryArtifact
  const original = path.join(directory, name)
  const target = path.join(await temporary(t), 'payload')
  await writeFile(target, await readFile(original))
  await rm(original)
  await symlink(target, original)
  await assert.rejects(verifyReleasePayload(directory, 'windows'), /without links/)
  const clean = await fixture(t, { platform: 'windows' })
  const destination = path.join(await temporary(t), 'stage')
  await symlink(clean, destination)
  await assert.rejects(stageReleaseAssets(clean, destination, 'windows', { approvedSha }), /EEXIST/)
  assert.deepEqual(
    await verifyReleaseDirectory(clean, { platform: 'windows', approvedSha }),
    releaseAssets('windows'),
  )
})

test('checksums never overwrite prior proof files', async (t) => {
  const directory = await fixture(t, { platform: 'windows' })
  const name = releaseConfig.platforms.windows.provenance
  const before = await readFile(path.join(directory, name), 'utf8')
  await assert.rejects(generateReleaseChecksums(directory, 'windows', { approvedSha }), /EEXIST/)
  assert.equal(await readFile(path.join(directory, name), 'utf8'), before)
})

test('source validation requires the exact selected clean main checkout', () => {
  const input = {
    approvedSha,
    eventSha: approvedSha,
    checkoutSha: approvedSha,
    eventRef: 'refs/heads/main',
  }
  assert.equal(verifyReleaseInput(input), approvedSha)
  for (const change of [
    { eventSha: otherSha },
    { checkoutSha: otherSha },
    { approvedSha: undefined },
    { approvedSha: approvedSha.toUpperCase() },
    { eventRef: 'refs/heads/nightly' },
    { dirty: true },
  ]) {
    assert.throws(() => verifyReleaseInput({ ...input, ...change }))
  }
})

test('NSIS smoke cannot alter a normal developer or self-hosted installation', () => {
  for (const env of [
    {},
    { GITHUB_ACTIONS: 'true' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
  ]) {
    assert.throws(() => assertInstallerProofHost(env), /isolated/)
  }
  assert.doesNotThrow(() =>
    assertInstallerProofHost({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }),
  )
})

test('real ASAR resources retain every reference byte, license file, and the resolved updater channel', async (t) => {
  const temporaryRoot = await temporary(t)
  const source = path.join(temporaryRoot, 'source')
  const resources = path.join(temporaryRoot, 'resources')
  const archiveInput = path.join(temporaryRoot, 'archive-input')
  const references = path.join(source, 'packages', 'design-agent', 'references')
  const packedReferences = path.join(
    archiveInput,
    'node_modules',
    '@harness',
    'design-agent',
    'references',
  )
  await mkdir(references, { recursive: true })
  await writeFile(path.join(references, 'direction.webp'), 'RIFF-reference-bytes-WEBP')
  await mkdir(path.join(references, 'library'))
  await writeFile(path.join(references, 'library', 'catalog.json'), '{"version":1}')
  await writeFile(path.join(references, 'library', 'hero.png'), 'PNG-library-reference')
  await mkdir(packedReferences, { recursive: true })
  await cp(references, packedReferences, { recursive: true })
  await mkdir(resources)
  const archive = path.join(resources, 'app.asar')
  const asar = packagingAsar()
  const pack = () =>
    asar.createPackageWithOptions(archiveInput, archive, {
      unpackDir: 'node_modules/@harness/design-agent/references/library',
    })
  await pack()
  assert.equal(await verifyBundledDesignReferences(archive, references), 3)
  await mkdir(path.join(source, 'release'))
  await mkdir(path.join(source, 'licenses'))
  await writeFile(path.join(source, 'licenses', 'reviewed.txt'), 'Reviewed dependency license')
  await cp(path.join(source, 'licenses'), path.join(resources, 'licenses'), { recursive: true })
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) {
    await writeFile(
      path.join(name === 'THIRD_PARTY_LICENSES.txt' ? path.join(source, 'release') : source, name),
      `Current ${name}`,
    )
    await writeFile(path.join(resources, name), `Current ${name}`)
  }
  await mkdir(path.join(resources, 'web'))
  await writeFile(path.join(resources, 'web', 'index.html'), '<html>Packaged renderer</html>')
  const updater = {
    ...releaseConfig.publish,
    channel: releaseConfig.updaterChannel,
    updaterCacheDirName: 'test-updater',
  }
  const updaterFile = path.join(resources, 'app-update.yml')
  await writeFile(updaterFile, dump(updater))
  await verifyPackagedResources(resources, releaseConfig, source)
  await writeFile(updaterFile, dump({ ...updater, channel: 'wrong' }))
  await assert.rejects(verifyPackagedResources(resources, releaseConfig, source), /configured feed/)
  await writeFile(updaterFile, dump(updater))
  await writeFile(path.join(resources, 'LICENSE'), 'stale license')
  await assert.rejects(
    verifyPackagedResources(resources, releaseConfig, source),
    /license does not match/,
  )
  await writeFile(path.join(resources, 'LICENSE'), 'Current LICENSE')
  await rm(path.join(packedReferences, 'library', 'catalog.json'))
  await pack()
  await assert.rejects(verifyBundledDesignReferences(archive, references), /reference filenames/)
  await cp(references, packedReferences, { recursive: true })
  await writeFile(path.join(packedReferences, 'direction.webp'), 'Changed image bytes')
  await pack()
  await assert.rejects(verifyPackagedResources(resources, releaseConfig, source), /reference bytes/)
  await writeFile(path.join(packedReferences, 'unexpected.webp'), 'Extra image bytes')
  await pack()
  await assert.rejects(verifyBundledDesignReferences(archive, references), /reference filenames/)
})

test('draft uploads require exact explicit approval and a safe repository name', async (t) => {
  const directory = await fixture(t)
  for (const override of [
    { uploadApproval: undefined },
    { uploadApproval: otherSha },
    { repository: 'test/repo?token=bad' },
    { repository: 'test/../other' },
    { token: '' },
  ]) {
    const mock = github()
    await assert.rejects(upload(directory, mock, override))
    assert.equal(mock.state.calls.length, 0)
  }
})

test('one exact draft is created, remotely hash checked, and reruns are read-only', async (t) => {
  const directory = await fixture(t)
  const mock = github()
  const result = await upload(directory, mock)
  assert.equal(result.release.draft, true)
  assert.equal(result.release.target_commitish, approvedSha)
  assert.equal(mock.state.releases.length, 1)
  assert.deepEqual(result.assets.map((asset) => asset.name).sort(), releaseAssets())
  for (const asset of result.assets)
    assert.equal(asset.digest, `sha256:${await hashFile(path.join(directory, asset.name))}`)
  assert.equal(mock.state.mutations.length, releaseAssets().length + 1)
  const count = mock.state.mutations.length
  await upload(directory, mock)
  assert.equal(mock.state.mutations.length, count)
  assert.ok(mock.state.mutations.every((entry) => entry.method === 'POST'))
})

test('stale, foreign, published, and duplicate drafts are left untouched', async (t) => {
  const directory = await fixture(t)
  for (const releases of [
    [{ ...draft(), target_commitish: otherSha }],
    [{ ...draft(), body: 'human notes' }],
    [{ ...draft(), draft: false }],
    [draft(), draft(8)],
  ]) {
    const mock = github({ releases })
    await assert.rejects(upload(directory, mock), /match|published|Multiple/)
    assert.deepEqual(mock.state.mutations, [])
    assert.deepEqual(mock.state.releases, releases)
  }
})

test('main and existing tag references must resolve to the approved SHA', async (t) => {
  const directory = await fixture(t)
  for (const config of [
    { mainSha: otherSha },
    { tagObject: { type: 'commit', sha: otherSha } },
    { tagObject: { type: 'tree', sha: approvedSha } },
  ]) {
    const mock = github(config)
    await assert.rejects(upload(directory, mock), /commit/)
    assert.deepEqual(mock.state.mutations, [])
  }
  const annotated = github({
    tagObject: { type: 'tag', sha: otherSha },
    beforeRequest: ({ url }) =>
      url.pathname.includes('/git/tags/')
        ? json({ object: { type: 'commit', sha: approvedSha } })
        : undefined,
  })
  assert.equal((await upload(directory, annotated)).release.draft, true)
})

test('draft lookup checks every page and fails closed on an unbounded list', async (t) => {
  const directory = await fixture(t)
  const unrelated = Array.from({ length: 100 }, (_, index) => ({
    id: index + 100,
    tag_name: `old-${index}`,
  }))
  const duplicate = github({ releases: [...unrelated, draft(), draft(8)] })
  await assert.rejects(upload(directory, duplicate), /Multiple/)
  assert.deepEqual(duplicate.state.mutations, [])
  const endless = github({
    beforeRequest: ({ url }) => (url.pathname.endsWith('/releases') ? json(unrelated) : undefined),
  })
  await assert.rejects(upload(directory, endless), /pagination/)
  assert.deepEqual(endless.state.mutations, [])
})

test('partial upload failures can resume matching bytes without deleting or replacing assets', async (t) => {
  const directory = await fixture(t)
  let fail = true
  const mock = github({
    beforeRequest: ({ url, method, state }) => {
      if (
        fail &&
        method === 'POST' &&
        url.hostname === 'uploads.github.com' &&
        state.assets.length === 2
      )
        return json({ message: 'private reflected input' }, 502)
    },
  })
  await assert.rejects(
    upload(directory, mock),
    (error) => /HTTP 502/.test(error.message) && !error.message.includes('private reflected input'),
  )
  assert.equal(mock.state.assets.length, 2)
  const firstIds = mock.state.assets.map((asset) => asset.id)
  fail = false
  await upload(directory, mock)
  assert.deepEqual(
    mock.state.assets.slice(0, 2).map((asset) => asset.id),
    firstIds,
  )
  assert.equal(mock.state.assets.length, releaseAssets().length)
})

test('unexpected, bad-digest, duplicate, or unfinished remote assets prevent all writes', async (t) => {
  const directory = await fixture(t)
  const name = releaseAssets()[0]
  const bytes = await readFile(path.join(directory, name))
  const valid = {
    id: 20,
    name,
    size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    state: 'uploaded',
  }
  for (const assets of [
    [{ ...valid, name: 'internal.txt' }],
    [{ ...valid, digest: 'sha256:wrong' }],
    [{ ...valid, digest: undefined }],
    [{ ...valid, state: 'starter' }],
    [{ ...valid, size: valid.size + 1 }],
    [valid, { ...valid, id: 21 }],
  ]) {
    const mock = github({ releases: [draft()], assets })
    await assert.rejects(upload(directory, mock), /asset/)
    assert.deepEqual(mock.state.mutations, [])
  }
})

test('racing draft creation is never retried or allowed to reach assets', async (t) => {
  const directory = await fixture(t)
  const conflict = github({
    beforeRequest: ({ url, method }) =>
      method === 'POST' && url.pathname.endsWith('/releases') ? json({}, 422) : undefined,
  })
  await assert.rejects(upload(directory, conflict), /HTTP 422/)
  assert.equal(conflict.state.mutations.length, 1)
  const duplicate = github({
    beforeRequest: ({ url, method, state }) => {
      if (method === 'GET' && url.pathname.endsWith('/releases') && state.releases.length === 1)
        state.releases.push(draft(101))
    },
  })
  await assert.rejects(upload(directory, duplicate), /Multiple/)
  assert.equal(duplicate.state.mutations.length, 1)
  assert.equal(duplicate.state.assets.length, 0)
  const movedMain = github({
    beforeRequest: ({ url, state }) => {
      if (url.pathname.endsWith('/releases')) state.mainSha = otherSha
    },
  })
  await assert.rejects(upload(directory, movedMain), /current main/)
  assert.deepEqual(movedMain.state.mutations, [])
})

test('mid-upload publication, retargeting, duplicate creation, and main movement stop the writer', async (t) => {
  const directory = await fixture(t)
  for (const mutate of [
    (state) => {
      state.releases[0].draft = false
    },
    (state) => {
      state.releases[0].target_commitish = otherSha
    },
    (state) => {
      state.releases.push(draft(101))
    },
    (state) => {
      state.mainSha = otherSha
    },
  ]) {
    let changed = false
    const mock = github({
      beforeRequest: ({ state }) => {
        if (state.assets.length === 1 && !changed) {
          changed = true
          mutate(state)
        }
      },
    })
    await assert.rejects(upload(directory, mock), /published|match|Multiple|current main/)
    assert.equal(mock.state.assets.length, 1)
    assert.equal(mock.state.mutations.length, 2)
  }
})

test('upload response bytes and local source mutations cannot pass on size alone', async (t) => {
  const directory = await fixture(t)
  const corrupt = github({
    beforeRequest: async ({ url, method, options }) => {
      if (method === 'POST' && url.hostname === 'uploads.github.com') {
        for await (const _chunk of options.body) {
          /* Drain the local stream before replying. */
        }
        return json(
          {
            id: 20,
            name: url.searchParams.get('name'),
            state: 'uploaded',
            size: Number(options.headers['Content-Length']),
            digest: 'sha256:wrong',
          },
          201,
        )
      }
    },
  })
  await assert.rejects(upload(directory, corrupt), /SHA-256/)
  const changed = github({
    beforeRequest: async ({ url, state }) => {
      if (url.pathname.endsWith('/git/ref/heads/main') && state.releases.length === 1)
        await writeFile(path.join(directory, releaseAssets()[0]), 'modified')
    },
  })
  await assert.rejects(upload(directory, changed), /changed before upload/)
  assert.equal(changed.state.assets.length, 0)
})

test('workflow is manual, pinned, read-only by default, and has one optional writer', async () => {
  const source = await readFile(
    path.join(repositoryRoot, '.github', 'workflows', 'release-artifact-proof.yml'),
    'utf8',
  )
  const workflow = load(source)
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.equal(workflow.on.workflow_dispatch.inputs.upload_draft.default, false)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.concurrency, {
    group: 'release-artifact-proof',
    'cancel-in-progress': false,
  })
  const writers = Object.entries(workflow.jobs).filter(
    ([, job]) => job.permissions.contents === 'write',
  )
  assert.equal(writers.length, 1)
  const [writerName, writer] = writers[0]
  assert.equal(writerName, 'upload-draft')
  assert.equal(
    writer.if,
    "inputs.upload_draft && github.ref == 'refs/heads/main' && inputs.approved_sha == github.sha",
  )
  assert.equal(
    workflow.jobs['verify-input'].if,
    "github.ref == 'refs/heads/main' && inputs.approved_sha == github.sha",
  )
  assert.deepEqual(writer.needs, ['verify-input', 'package'])
  assert.equal(
    writer.steps.filter((step) => step.run?.includes('upload-draft-release.js')).length,
    1,
  )
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.deepEqual(job.permissions, { contents: name === writerName ? 'write' : 'read' })
    assert.equal(job.steps.filter((step) => step.uses?.startsWith('actions/setup-node@')).length, 1)
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/)
      if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with['node-version'], 24)
      if (step.uses?.startsWith('actions/checkout@'))
        assert.equal(step.with['persist-credentials'], false)
      if (name !== writerName)
        assert.doesNotMatch(JSON.stringify(step), /GITHUB_TOKEN|upload-draft-release/)
      if (step.uses?.startsWith('actions/download-artifact@')) {
        assert.equal(step.with.pattern, undefined)
        assert.match(step.with.name, /github\.run_id.*github\.run_attempt.*inputs\.approved_sha/)
      }
    }
  }
  for (const line of source.split('\n').filter((line) => /^\s*- uses:/.test(line))) {
    assert.match(line, /^\s*- uses: [\w/-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+\s*$/)
  }
  const desktop = JSON.parse(await readFile(path.join(desktopDirectory, 'package.json'), 'utf8'))
  assert.deepEqual(desktop.build.publish, [
    { provider: 'generic', url: 'https://tastecode.dev/releases' },
  ])
  assert.ok(
    desktop.build.asarUnpack.includes('node_modules/@harness/design-agent/references/library/**/*'),
  )
  for (const name of [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'licenses',
    'THIRD_PARTY_LICENSES.txt',
  ])
    assert.ok(desktop.build.extraResources.some((entry) => entry.to === name))
  assert.match(desktop.scripts['test:release-tools'], /release-tools\.test\.js/)
  assert.ok(checksumPayloadAssets('macos').includes(releaseConfig.platforms.macos.provenance))
})
