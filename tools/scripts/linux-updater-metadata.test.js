import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import yaml from 'js-yaml'

import {
  channelFileNameForVersion,
  expectedLinuxArtifactNames,
  parseDirArgs,
} from './linux-release-shared.js'
import { verifyLinuxUpdaterMetadata } from './linux-updater-metadata.js'

const VERSION = '9.9.9-beta.1'
const APP = `TasteCode-${VERSION}-linux-x86_64.AppImage`
const DEB = `TasteCode-${VERSION}-linux-amd64.deb`
const EXPECTED = [APP, DEB].sort()

const b64 = (data) => createHash('sha512').update(data).digest('base64')

// Fake AppImage with a real embedded blockmap: payload + deflateRaw blockmap
// JSON + 4-byte big-endian segment length, mirroring electron-builder output.
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-updater-test-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeFixture(dir, { version = VERSION, mutate = null } = {}) {
  const appFile = `TasteCode-${version}-linux-x86_64.AppImage`
  const debFile = `TasteCode-${version}-linux-amd64.deb`
  const { binary, segment } = appBinary(`payload for ${version}\nsecond line\n`)
  const debPayload = `deb for ${version}\n`
  await writeFile(path.join(dir, appFile), binary)
  await writeFile(path.join(dir, debFile), debPayload, 'utf8')
  const doc = {
    version,
    files: [
      { url: appFile, sha512: b64(binary), size: binary.length, blockMapSize: segment.length },
      { url: debFile, sha512: b64(debPayload), size: Buffer.byteLength(debPayload) },
    ],
    path: appFile,
    sha512: b64(binary),
    releaseDate: '2026-09-07T16:59:40.593Z',
  }
  if (mutate) mutate(doc)
  const channelFile = channelFileNameForVersion(version, '[test]')
  await writeFile(path.join(dir, channelFile), yaml.dump(doc), 'utf8')
  return { binary, segment, channelFile }
}

const namesFor = (version) =>
  [`TasteCode-${version}-linux-amd64.deb`, `TasteCode-${version}-linux-x86_64.AppImage`].sort()

for (const [version, channelFile] of [
  [VERSION, 'beta-linux.yml'],
  ['9.9.9', 'latest-linux.yml'],
]) {
  test(`verifies ${channelFile} with AppImage legacy fields`, () =>
    withDir(async (directory) => {
      await writeFixture(directory, { version })
      const result = await verifyLinuxUpdaterMetadata(directory, {
        version,
        expectedArtifacts: namesFor(version),
      })
      assert.equal(result.channelFile, channelFile)
      assert.equal(result.metadata.path, `TasteCode-${version}-linux-x86_64.AppImage`)
    }))
}

test('rejects tampered hashes, sizes, legacy fields, and shapes', async (t) => {
  const cases = {
    'version mismatch': (d) => (d.version = '9.9.9-beta.2'),
    'AppImage hash': (d) => (d.files[0].sha512 = b64('tampered')),
    'deb size': (d) => (d.files[1].size = 1),
    'missing blockMapSize': (d) => delete d.files[0].blockMapSize,
    'deb blockMapSize': (d) => (d.files[1].blockMapSize = 4),
    'blockMapSize 1': (d) => (d.files[0].blockMapSize = 1),
    'legacy path': (d) => (d.path = DEB),
    'legacy sha512': (d) => (d.sha512 = b64('tampered')),
    releaseDate: (d) => (d.releaseDate = 'not-a-date'),
    'extra top-level key': (d) => (d.releaseNotes = 'hi'),
    'wrong file list': (d) => (d.files[1].url = 'TasteCode-old.deb'),
  }
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, () =>
      withDir(async (directory) => {
        await writeFixture(directory, { mutate })
        await assert.rejects(
          verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
          /linux-updater-metadata/,
        )
      }),
    )
  }
})

test('rejects blockmap trailer and deflate tampering', async () => {
  await withDir(async (directory) => {
    const { binary } = await writeFixture(directory)
    const tampered = Buffer.from(binary)
    tampered[tampered.length - 1] ^= 0xff
    await writeFile(path.join(directory, APP), tampered)
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
      /blockmap trailer/,
    )
  })
  await withDir(async (directory) => {
    const { binary, segment } = await writeFixture(directory)
    const tampered = Buffer.from(binary)
    tampered[tampered.length - 4 - segment.length] ^= 0xff
    await writeFile(path.join(directory, APP), tampered)
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
      /not valid deflate/,
    )
  })
})

test('rejects missing, extra, unsafe, and unparsable files', async (t) => {
  await t.test('missing channel', () =>
    withDir(async (directory) => {
      const { binary } = appBinary('x\n')
      await writeFile(path.join(directory, APP), binary)
      await writeFile(path.join(directory, DEB), 'y\n', 'utf8')
      await assert.rejects(
        verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
        /updater metadata is missing: beta-linux\.yml/,
      )
    }),
  )
  for (const extra of [
    'latest-linux.yml',
    'beta-linux-arm.yml',
    'beta-linux-arm64.yml',
    `${APP}.blockmap`,
    'x.zip',
  ]) {
    await t.test(`extra ${extra}`, () =>
      withDir(async (directory) => {
        await writeFixture(directory)
        await writeFile(path.join(directory, extra), 'sidecar\n', 'utf8')
        await assert.rejects(
          verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
          /extra updater sidecars are rejected/,
        )
      }),
    )
  }
  await t.test('unparsable channel', () =>
    withDir(async (directory) => {
      await writeFixture(directory)
      await writeFile(path.join(directory, 'beta-linux.yml'), 'version: [oops\n', 'utf8')
      await assert.rejects(
        verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
        /does not parse/,
      )
    }),
  )
  await t.test('unsafe expected names', () =>
    withDir(async (directory) => {
      await writeFixture(directory)
      await assert.rejects(
        verifyLinuxUpdaterMetadata(directory, {
          version: VERSION,
          expectedArtifacts: ['../evil.AppImage', DEB],
        }),
        /unsafe file name|exactly one AppImage/,
      )
    }),
  )
})

test('pins unsafe templates, unknown macros, and the YAML size bound', () =>
  withDir(async (directory) => {
    assert.throws(
      () =>
        expectedLinuxArtifactNames(
          { version: VERSION, artifactName: '../evil-${version}.${ext}' },
          '[t]',
        ),
      /unsafe file name/,
    )
    assert.throws(
      () =>
        expectedLinuxArtifactNames({ version: VERSION, artifactName: 'ok-${bogus}.${ext}' }, '[t]'),
      /unsupported artifactName macro/,
    )
    await writeFixture(directory)
    await writeFile(
      path.join(directory, 'beta-linux.yml'),
      `${'version: 1.0.0\n'.padEnd(70_000, '#')}files:\n`,
      'utf8',
    )
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version: VERSION, expectedArtifacts: EXPECTED }),
      /exceeds 65536 bytes/,
    )
  }))

test('derives channels from semver prereleases', () => {
  assert.equal(channelFileNameForVersion('1.2.3', '[t]'), 'latest-linux.yml')
  assert.equal(channelFileNameForVersion('0.1.0-beta.1', '[t]'), 'beta-linux.yml')
  assert.equal(channelFileNameForVersion('1.0.0-rc.1+build.5', '[t]'), 'rc-linux.yml')
  for (const bad of ['', '1.0', 'v1.2.3', '1.2.3-beta!', 'latest']) {
    assert.throws(() => channelFileNameForVersion(bad, '[t]'), /invalid semver/)
  }
})

test('parses shared CLI args', () => {
  const args = { usage: 'node x [--dir <d>]', tag: '[t]', defaultDir: '/d' }
  assert.equal(parseDirArgs(['--dir', 'release'], args).dir, path.resolve('release'))
  assert.equal(parseDirArgs(['--dir=/tmp/x'], args).dir, path.resolve('/tmp/x'))
  assert.equal(parseDirArgs(['--help'], args).help, true)
  assert.throws(() => parseDirArgs(['--dir'], args), /--dir requires/)
  assert.throws(() => parseDirArgs(['--bogus'], args), /unknown argument/)
})
