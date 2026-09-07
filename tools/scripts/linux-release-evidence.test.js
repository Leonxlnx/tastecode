import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import yaml from 'js-yaml'

import {
  assertWorktreeClean,
  collectLinuxReleaseEvidence,
  worktreePorcelainStatus,
  writeLinuxReleaseEvidence,
} from './linux-release-evidence.js'
import { channelFileNameForVersion, expectedLinuxArtifactNames } from './linux-release-shared.js'

const VERSION = '9.9.9-test.1'
const COMMIT = 'a'.repeat(40)
const EXPECTED = expectedLinuxArtifactNames({ version: VERSION }, '[test]')
const APP = EXPECTED.find((name) => name.endsWith('.AppImage'))
const DEB = EXPECTED.find((name) => name.endsWith('.deb'))
const CHANNEL = channelFileNameForVersion(VERSION, '[test]')
const APP_PAYLOAD = `fake AppImage payload for ${VERSION}\n`
const DEB_PAYLOAD = `fake deb payload for ${VERSION}\n`

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const b64 = (data) => createHash('sha512').update(data).digest('base64')

function appBinary(payload) {
  const sizes = [Buffer.byteLength(payload, 'utf8')]
  const segment = deflateRawSync(
    Buffer.from(
      JSON.stringify({
        version: '2',
        files: [{ name: 'file', offset: 0, checksums: [b64(payload)], sizes }],
      }),
      'utf8',
    ),
  )
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(segment.length)
  return { binary: Buffer.concat([Buffer.from(payload, 'utf8'), segment, trailer]), segment }
}

async function withDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-evidence-test-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// describeChannel writes only the channel file for precomputed values; the
// empty-candidate test uses it to describe non-empty payloads while the
// AppImage on disk stays empty.
async function describeChannel(dir, { appBytes, appSha, block, debPayload = DEB_PAYLOAD }) {
  await writeFile(
    path.join(dir, CHANNEL),
    yaml.dump({
      version: VERSION,
      files: [
        { url: APP, sha512: appSha, size: appBytes, blockMapSize: block },
        { url: DEB, sha512: b64(debPayload), size: Buffer.byteLength(debPayload) },
      ],
      path: APP,
      sha512: appSha,
      releaseDate: '2026-09-07T16:59:40.593Z',
    }),
    'utf8',
  )
}

async function writeVerifiedSet(dir, { appPayload = APP_PAYLOAD, debPayload = DEB_PAYLOAD } = {}) {
  const { binary, segment } = appBinary(appPayload)
  await writeFile(path.join(dir, APP), binary)
  await writeFile(path.join(dir, DEB), debPayload, 'utf8')
  await describeChannel(dir, {
    appBytes: binary.length,
    appSha: b64(binary),
    block: segment.length,
    debPayload,
  })
  return binary
}

test('records verified metadata and stays deterministic', () =>
  withDir(async (directory) => {
    const binary = await writeVerifiedSet(directory)
    const { inventory, checksumText, channelFile } = await collectLinuxReleaseEvidence(directory, {
      version: VERSION,
      commit: COMMIT.toUpperCase(),
    })
    const channelText = await readFile(path.join(directory, CHANNEL), 'utf8')
    assert.equal(channelFile, CHANNEL)
    assert.equal(inventory.schemaVersion, 2)
    assert.deepEqual(inventory.artifacts, [
      { file: DEB, bytes: Buffer.byteLength(DEB_PAYLOAD), sha256: sha256(DEB_PAYLOAD) },
      { file: APP, bytes: binary.length, sha256: sha256(binary) },
    ])
    assert.deepEqual(inventory.updaterMetadata, {
      file: CHANNEL,
      bytes: Buffer.byteLength(channelText, 'utf8'),
      sha256: sha256(channelText),
    })
    assert.ok(checksumText.endsWith(`${sha256(channelText)}  ${CHANNEL}\n`))
    const first = await writeLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    const firstInventory = await readFile(first.inventoryPath, 'utf8')
    const second = await writeLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    assert.equal(await readFile(second.inventoryPath, 'utf8'), firstInventory)
    assert.deepEqual(Object.keys(JSON.parse(firstInventory)), [
      'artifacts',
      'commit',
      'schemaVersion',
      'updaterMetadata',
      'version',
    ])
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes('.tmp-')),
      [],
    )
  }))

test('requires candidates, channel, and verified content', async (t) => {
  await t.test('missing AppImage names the dist command', () =>
    withDir(async (directory) => {
      const { binary, segment } = appBinary(APP_PAYLOAD)
      await writeFile(path.join(directory, DEB), DEB_PAYLOAD, 'utf8')
      await describeChannel(directory, {
        appBytes: binary.length,
        appSha: b64(binary),
        block: segment.length,
      })
      await assert.rejects(
        collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
        /missing: TasteCode-.*\.AppImage.*pnpm --filter @harness\/desktop dist/,
      )
    }),
  )
  await t.test('missing channel is never silent', () =>
    withDir(async (directory) => {
      await writeVerifiedSet(directory)
      await rm(path.join(directory, CHANNEL))
      await assert.rejects(
        collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
        new RegExp(`missing: ${CHANNEL.replaceAll('.', '\\.')}`),
      )
    }),
  )
  await t.test('empty candidates are rejected', () =>
    withDir(async (directory) => {
      await writeFile(path.join(directory, APP), '')
      await writeFile(path.join(directory, DEB), DEB_PAYLOAD, 'utf8')
      const { binary, segment } = appBinary(APP_PAYLOAD)
      await describeChannel(directory, {
        appBytes: binary.length,
        appSha: b64(binary),
        block: segment.length,
      })
      await assert.rejects(
        collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
        /missing or empty/,
      )
    }),
  )
  await t.test('tampered payloads are rejected', () =>
    withDir(async (directory) => {
      await writeVerifiedSet(directory)
      await writeFile(path.join(directory, DEB), 'tampered\n', 'utf8')
      await assert.rejects(
        collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
        /linux-updater-metadata/,
      )
    }),
  )
})

test('rejects stale artifacts and unverified sidecars', () =>
  withDir(async (directory) => {
    // beta-linux.yml and the same-channel arch leftover are not the expected
    // test-linux.yml: both must fail, never pass silently.
    const extras = [
      'TasteCode-0.0.0-old-linux-amd64.deb',
      `${APP}.blockmap`,
      'beta-linux.yml',
      'test-linux-arm64.yml',
      `TasteCode-${VERSION}-linux-x64.zip`,
    ]
    await writeVerifiedSet(directory)
    for (const name of extras) await writeFile(path.join(directory, name), 'stale\n', 'utf8')
    let error
    try {
      await collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    } catch (candidate) {
      error = candidate
    }
    assert.ok(error, 'expected stale files and sidecars to be rejected')
    for (const name of extras) assert.ok(error.message.includes(name), `names ${name}`)
    assert.match(error.message, /updater-metadata gate/)
  }))

test('dirty worktrees stay fail-closed', async () => {
  assert.doesNotThrow(() => assertWorktreeClean(''))
  try {
    assertWorktreeClean(' M tools/scripts/linux-release-evidence.js\n')
    assert.fail('expected refusal')
  } catch (error) {
    assert.match(error.message, /worktree is dirty/)
    assert.equal(error.code, 'LINUX_EVIDENCE_DIRTY_WORKTREE')
  }
  let git = true
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    git = false
  }
  if (!git) return
  const repo = await mkdtemp(path.join(os.tmpdir(), 'tastecode-evidence-git-test-'))
  try {
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    await writeFile(path.join(repo, 'file.txt'), 'hello\n', 'utf8')
    execFileSync('git', ['add', 'file.txt'], { cwd: repo, stdio: 'ignore' })
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-m', 'init'],
      { cwd: repo, stdio: 'ignore' },
    )
    assert.doesNotThrow(() => assertWorktreeClean(worktreePorcelainStatus(repo)))
    await writeFile(path.join(repo, 'file.txt'), 'dirty\n', 'utf8')
    assert.throws(() => assertWorktreeClean(worktreePorcelainStatus(repo)), /worktree is dirty/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
