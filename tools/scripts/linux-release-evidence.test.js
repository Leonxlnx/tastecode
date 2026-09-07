import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'

import {
  argumentsFrom,
  assertWorktreeClean,
  collectLinuxReleaseEvidence,
  expectedLinuxArtifactNames,
  worktreePorcelainStatus,
  writeLinuxReleaseEvidence,
} from './linux-release-evidence.js'
import { channelFileNameForVersion } from './linux-updater-metadata.js'

const version = '9.9.9-test.1'
const commit = 'a'.repeat(40)
const expectedNames = expectedLinuxArtifactNames({ version })
const appImage = expectedNames.find((fileName) => fileName.endsWith('.AppImage'))
const deb = expectedNames.find((fileName) => fileName.endsWith('.deb'))
const channelFile = channelFileNameForVersion(version)
const appImageContents = `fake AppImage payload for ${version}\n`
const debContents = `fake deb payload for ${version}\n`

function sha256Text(contents) {
  return createHash('sha256').update(contents, 'utf8').digest('hex')
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sha512Text(contents) {
  return createHash('sha512').update(contents, 'utf8').digest('base64')
}

async function fixtureDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-evidence-test-'))
}

async function writeCandidate(directory, fileName, contents = `${fileName} contents\n`) {
  await writeFile(path.join(directory, fileName), contents, 'utf8')
}

// Fake AppImage bytes with a real embedded blockmap (payload + deflateRaw
// blockmap JSON + 4-byte big-endian segment length), mirroring
// electron-builder output so the updater-metadata gate can verify fixtures.
function buildAppImageBinary(payload) {
  const payloadBytes = Buffer.byteLength(payload, 'utf8')
  const blockmapJson = JSON.stringify({
    version: '2',
    files: [{ name: 'file', offset: 0, checksums: [sha512Text(payload)], sizes: [payloadBytes] }],
  })
  const segment = deflateRawSync(Buffer.from(blockmapJson, 'utf8'))
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(segment.length)
  return {
    binary: Buffer.concat([Buffer.from(payload, 'utf8'), segment, trailer]),
    blockMapSize: segment.length,
  }
}

function sha512Buffer(buffer) {
  return createHash('sha512').update(buffer).digest('base64')
}

// Write only the gate-verified channel file for precomputed artifact values;
// unlike writeVerifiedSet it never touches the candidates on disk.
async function writeVerifiedChannel(
  directory,
  { appBytes, appSha512, blockMapSize, debPayload = debContents },
) {
  const debBytes = Buffer.byteLength(debPayload, 'utf8')
  const lines = [
    `version: ${version}`,
    'files:',
    `  - url: ${appImage}`,
    `    sha512: ${appSha512}`,
    `    size: ${appBytes}`,
    `    blockMapSize: ${blockMapSize}`,
    `  - url: ${deb}`,
    `    sha512: ${sha512Text(debPayload)}`,
    `    size: ${debBytes}`,
    `path: ${appImage}`,
    `sha512: ${appSha512}`,
    "releaseDate: '2026-09-07T16:59:40.593Z'",
  ]
  await writeFile(path.join(directory, channelFile), `${lines.join('\n')}\n`, 'utf8')
}

// Write candidates plus their gate-verified channel file. Payloads default to
// the fixture contents so the metadata matches the candidates on disk.
async function writeVerifiedSet(
  directory,
  { appImagePayload = appImageContents, debPayload = debContents } = {},
) {
  const { binary, blockMapSize } = buildAppImageBinary(appImagePayload)
  await writeFile(path.join(directory, appImage), binary)
  await writeCandidate(directory, deb, debPayload)
  await writeVerifiedChannel(directory, {
    appBytes: binary.length,
    appSha512: sha512Buffer(binary),
    blockMapSize,
    debPayload,
  })
  return { appBinary: binary, blockMapSize }
}

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('expected names follow the checked-in artifact template for x64 targets', () => {
  assert.deepEqual(expectedLinuxArtifactNames({ version }), [
    `TasteCode-${version}-linux-amd64.deb`,
    `TasteCode-${version}-linux-x86_64.AppImage`,
  ])
})

test('unsafe artifact templates and versions are rejected', () => {
  for (const artifactName of [
    '../evil-${version}.${ext}',
    '${version}/${arch}.${ext}',
    '..\\evil-${version}.${ext}',
    '/absolute/evil-${version}.${ext}',
  ]) {
    assert.throws(
      () => expectedLinuxArtifactNames({ version, artifactName }),
      /unsafe artifact name/,
    )
  }
  assert.throws(
    () => expectedLinuxArtifactNames({ version, artifactName: 'ok-${bogus}.${ext}' }),
    /unsupported artifactName macro/,
  )
  assert.throws(() => expectedLinuxArtifactNames({ version: '../evil' }), /unsafe artifact name/)
})

test('inventory records exact checksums, byte sizes, commit, version, and verified metadata', async () => {
  const directory = await fixtureDirectory()
  try {
    const { appBinary } = await writeVerifiedSet(directory)
    const {
      inventory,
      checksumText,
      channelFile: verifiedFile,
    } = await collectLinuxReleaseEvidence(directory, {
      version,
      commit: commit.toUpperCase(),
    })
    const appImageHash = sha256Buffer(appBinary)
    const debHash = sha256Text(debContents)
    const channelContents = await readFile(path.join(directory, channelFile), 'utf8')
    const channelHash = sha256Text(channelContents)

    assert.equal(verifiedFile, channelFile)
    assert.equal(inventory.version, version)
    assert.equal(inventory.commit, commit)
    assert.equal(inventory.schemaVersion, 2)
    assert.deepEqual(inventory.artifacts, [
      { file: deb, bytes: Buffer.byteLength(debContents), sha256: debHash },
      { file: appImage, bytes: appBinary.length, sha256: appImageHash },
    ])
    assert.deepEqual(inventory.updaterMetadata, {
      file: channelFile,
      bytes: Buffer.byteLength(channelContents, 'utf8'),
      sha256: channelHash,
    })
    assert.equal(
      checksumText,
      `${debHash}  ${deb}\n${appImageHash}  ${appImage}\n${channelHash}  ${channelFile}\n`,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing candidates fail with the repository dist command', async () => {
  const directory = await fixtureDirectory()
  try {
    // The channel describes the full set so the missing AppImage is reported.
    const { binary, blockMapSize } = buildAppImageBinary(appImageContents)
    await writeCandidate(directory, deb, debContents)
    await writeVerifiedChannel(directory, {
      appBytes: binary.length,
      appSha512: sha512Buffer(binary),
      blockMapSize,
      debPayload: debContents,
    })
    await assert.rejects(
      collectLinuxReleaseEvidence(directory, { version, commit }),
      /missing: TasteCode-.*\.AppImage.*pnpm --filter @harness\/desktop dist/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing channel metadata fails instead of staying silent', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedSet(directory)
    await rm(path.join(directory, channelFile))
    await assert.rejects(
      collectLinuxReleaseEvidence(directory, { version, commit }),
      new RegExp(`missing: ${channelFile.replaceAll('.', '\\.')}`),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stale artifacts and updater sidecars are rejected, never ignored', async () => {
  const directory = await fixtureDirectory()
  const staleDeb = 'TasteCode-0.0.0-old-linux-amd64.deb'
  const blockmap = `${appImage}.blockmap`
  // Neither the foreign beta channel nor the same-channel arch leftover is the
  // expected test-linux.yml: both must be rejected, never silently ignored.
  const unverifiedChannel = 'beta-linux.yml'
  const archLeftover = 'test-linux-arm64.yml'
  const zip = `TasteCode-${version}-linux-x64.zip`
  try {
    await writeVerifiedSet(directory)
    await writeCandidate(directory, staleDeb)
    await writeCandidate(directory, blockmap)
    await writeCandidate(directory, unverifiedChannel)
    await writeCandidate(directory, archLeftover)
    await writeCandidate(directory, zip)

    let error
    try {
      await collectLinuxReleaseEvidence(directory, { version, commit })
    } catch (candidate) {
      error = candidate
    }
    assert.ok(error, 'expected stale files and updater sidecars to be rejected')
    for (const name of [staleDeb, blockmap, unverifiedChannel, archLeftover, zip]) {
      assert.ok(error.message.includes(name), `expected the failure to name ${name}`)
    }
    assert.match(error.message, /updater-metadata gate/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tampered channel metadata is rejected and never recorded', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedSet(directory)
    // Tamper the payload after the metadata was written so the gate hash check fails.
    await writeCandidate(directory, deb, 'tampered deb payload\n')
    await assert.rejects(
      collectLinuxReleaseEvidence(directory, { version, commit }),
      /linux-updater-metadata/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('empty candidates are rejected', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeCandidate(directory, appImage, '')
    await writeCandidate(directory, deb, debContents)
    // The channel describes the non-empty payloads so the empty candidate is
    // reached and refused instead of masking as a hash mismatch.
    const { binary, blockMapSize } = buildAppImageBinary(appImageContents)
    await writeVerifiedChannel(directory, {
      appBytes: binary.length,
      appSha512: sha512Buffer(binary),
      blockMapSize,
      debPayload: debContents,
    })
    await assert.rejects(
      collectLinuxReleaseEvidence(directory, { version, commit }),
      /release candidate is (empty|missing or empty)/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('written inventory and checksums are deterministic and leave no temp files', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedSet(directory)
    const first = await writeLinuxReleaseEvidence(directory, { version, commit })
    const firstInventory = await readFile(first.inventoryPath, 'utf8')
    const firstChecksums = await readFile(first.checksumsPath, 'utf8')
    const second = await writeLinuxReleaseEvidence(directory, { version, commit })

    assert.equal(await readFile(second.inventoryPath, 'utf8'), firstInventory)
    assert.equal(await readFile(second.checksumsPath, 'utf8'), firstChecksums)
    assert.deepEqual(Object.keys(JSON.parse(firstInventory)), [
      'artifacts',
      'commit',
      'schemaVersion',
      'updaterMetadata',
      'version',
    ])
    assert.deepEqual(
      (await readdir(directory)).filter((fileName) => fileName.includes('.tmp-')),
      [],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the dirty worktree gate refuses non-empty porcelain output', () => {
  assert.doesNotThrow(() => assertWorktreeClean(''))
  assert.doesNotThrow(() => assertWorktreeClean('\n'))
  try {
    assertWorktreeClean(' M tools/scripts/linux-release-evidence.js\n')
    assert.fail('expected a dirty worktree to be refused')
  } catch (error) {
    assert.match(error.message, /worktree is dirty/)
    assert.equal(error.code, 'LINUX_EVIDENCE_DIRTY_WORKTREE')
  }
})

test('the worktree status runner is injectable', () => {
  let seen
  const output = worktreePorcelainStatus('/repo', (command, args, options) => {
    seen = { command, args, options }
    return ' M dirty.txt\n'
  })

  assert.equal(output, ' M dirty.txt\n')
  assert.equal(seen.command, 'git')
  assert.deepEqual(seen.args, ['status', '--porcelain'])
  assert.equal(seen.options.cwd, '/repo')
})

test('dirty worktree detection against a temp git repo', { skip: !gitAvailable() }, async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-evidence-git-test-'))
  try {
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    await writeFile(path.join(repo, 'file.txt'), 'hello\n', 'utf8')
    execFileSync('git', ['add', 'file.txt'], { cwd: repo, stdio: 'ignore' })
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-m', 'init'],
      { cwd: repo, stdio: 'ignore' },
    )

    assert.equal(worktreePorcelainStatus(repo).trim(), '')
    assert.doesNotThrow(() => assertWorktreeClean(worktreePorcelainStatus(repo)))

    await writeFile(path.join(repo, 'file.txt'), 'dirty\n', 'utf8')
    assert.throws(() => assertWorktreeClean(worktreePorcelainStatus(repo)), /worktree is dirty/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('CLI arguments parse --dir, reject missing values, and reject unknown flags', () => {
  assert.equal(argumentsFrom(['--dir', 'release']).dir, path.resolve('release'))
  assert.equal(argumentsFrom(['--dir=/tmp/x']).dir, path.resolve('/tmp/x'))
  assert.equal(argumentsFrom(['--help']).help, true)
  assert.equal(argumentsFrom(['-h']).help, true)
  assert.throws(() => argumentsFrom(['--dir']), /--dir requires a non-empty path/)
  assert.throws(() => argumentsFrom(['--dir=']), /--dir requires a non-empty path/)
  assert.throws(() => argumentsFrom(['--bogus']), /unknown argument/)
})
