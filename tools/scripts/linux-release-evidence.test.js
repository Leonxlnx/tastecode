import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBuildProvenance } from './build-provenance.js'
import {
  assertArtifactProvenance,
  assertConfiguredDebDependencies,
  assertWorktreeClean,
  collectLinuxReleaseEvidence as collectLinuxReleaseEvidenceRaw,
  worktreePorcelainStatus,
  writeLinuxReleaseEvidence as writeLinuxReleaseEvidenceRaw,
} from './linux-release-evidence.js'
import { expectedLinuxArtifactNames } from './linux-release-shared.js'

const VERSION = '9.9.9-test.1'
const COMMIT = 'a'.repeat(40)
const EXPECTED = expectedLinuxArtifactNames({ version: VERSION }, '[test]')
const APP = EXPECTED.find((name) => name.endsWith('.AppImage'))
const DEB = EXPECTED.find((name) => name.endsWith('.deb'))
const APP_PAYLOAD = `fake AppImage payload for ${VERSION}\n`
const DEB_PAYLOAD = `fake deb payload for ${VERSION}\n`
const readProvenance = async () => createBuildProvenance({ version: VERSION, commit: COMMIT })

function collectLinuxReleaseEvidence(directory, attestation) {
  return collectLinuxReleaseEvidenceRaw(directory, attestation, { readProvenance })
}

function writeLinuxReleaseEvidence(directory, options) {
  return writeLinuxReleaseEvidenceRaw(directory, { ...options, readProvenance })
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function withDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-evidence-test-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeCandidateSet(directory) {
  await writeFile(path.join(directory, APP), APP_PAYLOAD)
  await writeFile(path.join(directory, DEB), DEB_PAYLOAD)
}

test('requires configured FPM dependencies in the built deb', () => {
  assert.doesNotThrow(() =>
    assertConfiguredDebDependencies(
      'libgtk-3-0, libsecret-1-0, libasound2t64|libasound2, libuuid1',
      {
        depends: 'libgtk-3-0',
        fpm: ['--depends=libasound2t64 | libasound2', '-d', 'libuuid1'],
      },
    ),
  )
  assert.throws(
    () =>
      assertConfiguredDebDependencies('libgtk-3-0, libsecret-1-0', {
        fpm: ['--depends', 'libasound2t64 | libasound2'],
      }),
    /missing configured dependency: libasound2t64 \| libasound2/,
  )
  assert.throws(
    () => assertConfiguredDebDependencies('libgtk-3-0', { fpm: ['--depends'] }),
    /--depends requires a dependency value/,
  )
})

test('records a deterministic manual-only distribution manifest', () =>
  withDir(async (directory) => {
    await writeCandidateSet(directory)
    const { inventory, checksumText } = await collectLinuxReleaseEvidence(directory, {
      version: VERSION,
      commit: COMMIT.toUpperCase(),
    })
    assert.equal(inventory.schemaVersion, 4)
    assert.equal(inventory.updateMode, 'manual')
    assert.deepEqual(inventory.artifacts, [
      { file: DEB, bytes: Buffer.byteLength(DEB_PAYLOAD), sha256: sha256(DEB_PAYLOAD) },
      { file: APP, bytes: Buffer.byteLength(APP_PAYLOAD), sha256: sha256(APP_PAYLOAD) },
    ])
    assert.deepEqual(inventory.payloadProvenance, {
      artifacts: [DEB, APP].sort(),
      commit: COMMIT,
      schemaVersion: 1,
      version: VERSION,
    })
    assert.equal(checksumText, `${sha256(DEB_PAYLOAD)}  ${DEB}\n${sha256(APP_PAYLOAD)}  ${APP}\n`)

    const first = await writeLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    const firstInventory = await readFile(first.inventoryPath, 'utf8')
    const second = await writeLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    assert.equal(await readFile(second.inventoryPath, 'utf8'), firstInventory)
    assert.deepEqual(Object.keys(JSON.parse(firstInventory)), [
      'artifacts',
      'commit',
      'payloadProvenance',
      'schemaVersion',
      'updateMode',
      'version',
    ])
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes('.tmp-')),
      [],
    )
  }))

test('requires both nonempty Linux x64 candidates', async (t) => {
  await t.test('missing AppImage names the preparation command', () =>
    withDir(async (directory) => {
      await writeFile(path.join(directory, DEB), DEB_PAYLOAD)
      await assert.rejects(
        collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
        /missing: TasteCode-.*\.AppImage.*dist:linux/,
      )
    }),
  )
  await t.test('empty candidates are rejected', () =>
    withDir(async (directory) => {
      await writeFile(path.join(directory, APP), '')
      await writeFile(path.join(directory, DEB), DEB_PAYLOAD)
      await assert.rejects(
        collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
        /release candidate is empty/,
      )
    }),
  )
})

test('rejects every stale artifact and updater sidecar', () =>
  withDir(async (directory) => {
    const extras = [
      'TasteCode-0.0.0-old-linux-amd64.deb',
      `${APP}.blockmap`,
      'beta-linux.yml',
      `TasteCode-${VERSION}-linux-x64.zip`,
      'unexpected.txt',
    ]
    await writeCandidateSet(directory)
    for (const name of extras) await writeFile(path.join(directory, name), 'stale\n')
    let error
    try {
      await collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    } catch (candidate) {
      error = candidate
    }
    assert.ok(error, 'expected stale files and sidecars to be rejected')
    for (const name of extras) assert.ok(error.message.includes(name), `names ${name}`)
    assert.match(error.message, /manual-update only/)
  }))

test('rejects unexpected directories in the release distribution', () =>
  withDir(async (directory) => {
    await writeCandidateSet(directory)
    await mkdir(path.join(directory, 'unexpected'))
    await assert.rejects(
      collectLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
      /regular files only; rejected: unexpected/,
    )
  }))

test('existing evidence refuses replaced artifacts instead of blessing new bytes', () =>
  withDir(async (directory) => {
    await writeCandidateSet(directory)
    await writeLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT })
    await writeFile(path.join(directory, DEB), 'tampered\n')
    await assert.rejects(
      writeLinuxReleaseEvidence(directory, { version: VERSION, commit: COMMIT }),
      /existing Linux release evidence does not match/,
    )
  }))

test('dirty worktrees stay fail-closed', async () => {
  assert.doesNotThrow(() => assertWorktreeClean(''))
  try {
    assertWorktreeClean(' M tools/scripts/linux-release-evidence.js\n')
    assert.fail('expected refusal')
  } catch (error) {
    assert.match(error.message, /worktree is dirty/)
    assert.equal(error.code, 'BUILD_PROVENANCE_DIRTY_WORKTREE')
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
    await writeFile(path.join(repo, 'file.txt'), 'hello\n')
    execFileSync('git', ['add', 'file.txt'], { cwd: repo, stdio: 'ignore' })
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-m', 'init'],
      { cwd: repo, stdio: 'ignore' },
    )
    assert.doesNotThrow(() => assertWorktreeClean(worktreePorcelainStatus(repo)))
    await writeFile(path.join(repo, 'file.txt'), 'dirty\n')
    assert.throws(() => assertWorktreeClean(worktreePorcelainStatus(repo)), /worktree is dirty/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('rejects artifacts built from another commit or version', () => {
  assert.doesNotThrow(() =>
    assertArtifactProvenance(createBuildProvenance({ version: VERSION, commit: COMMIT }), {
      artifact: APP,
      version: VERSION,
      commit: COMMIT,
    }),
  )
  assert.throws(
    () =>
      assertArtifactProvenance(
        createBuildProvenance({ version: VERSION, commit: 'b'.repeat(40) }),
        { artifact: APP, version: VERSION, commit: COMMIT },
      ),
    /was not built from/,
  )
  assert.throws(
    () =>
      assertArtifactProvenance(createBuildProvenance({ version: '9.9.8', commit: COMMIT }), {
        artifact: DEB,
        version: VERSION,
        commit: COMMIT,
      }),
    /was not built from/,
  )
})
