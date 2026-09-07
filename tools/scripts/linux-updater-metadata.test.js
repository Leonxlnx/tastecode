import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'

import {
  argumentsFrom,
  assertLinuxUpdaterPolicy,
  channelFileNameForVersion,
  channelForVersion,
  parseConstrainedUpdaterYaml,
  sha512File,
  verifyLinuxUpdaterMetadata,
} from './linux-updater-metadata.js'

const version = '9.9.9-beta.1'
const appImage = `TasteCode-${version}-linux-x86_64.AppImage`
const deb = `TasteCode-${version}-linux-amd64.deb`
const expected = [deb, appImage].sort()
const appImageContents = `fake AppImage payload for ${version}\nwith a second line\n`
const debContents = `fake deb payload for ${version}\n`

function sha512Text(contents) {
  return createHash('sha512').update(contents, 'utf8').digest('base64')
}

function sha512Buffer(buffer) {
  return createHash('sha512').update(buffer).digest('base64')
}

// Build a fake AppImage with a real embedded blockmap: payload bytes followed
// by a deflateRaw-compressed blockmap JSON segment and a 4-byte big-endian
// trailer holding the segment length, mirroring electron-builder output.
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

async function fixtureDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'tastecode-updater-metadata-test-'))
}

async function writeVerifiedFixture(directory, overrides = {}) {
  const appImagePayload = overrides.appImagePayload ?? appImageContents
  const debPayload = overrides.debPayload ?? debContents
  const { binary, blockMapSize: realBlockMapSize } = buildAppImageBinary(appImagePayload)
  await writeFile(path.join(directory, appImage), binary)
  await writeFile(path.join(directory, deb), debPayload, 'utf8')
  const appImageBytes = binary.length
  const debBytes = Buffer.byteLength(debPayload, 'utf8')
  const appImageSha512 = sha512Buffer(binary)
  const debSha512 = sha512Text(debPayload)
  const channelVersion = overrides.version ?? version
  const channelAppImage = overrides.appImageName ?? appImage
  const channelDeb = overrides.debName ?? deb
  const lines = [
    `version: ${overrides.yamlVersion ?? channelVersion}`,
    'files:',
    `  - url: ${channelAppImage}`,
    `    sha512: ${overrides.appImageSha512 ?? appImageSha512}`,
    `    size: ${overrides.appImageSize ?? appImageBytes}`,
  ]
  if (!overrides.omitBlockMapSize) {
    lines.push(`    blockMapSize: ${overrides.blockMapSize ?? realBlockMapSize}`)
  }
  if (overrides.extraAppImageField) {
    lines.push(`    ${overrides.extraAppImageField}`)
  }
  lines.push(
    `  - url: ${channelDeb}`,
    `    sha512: ${overrides.debSha512 ?? debSha512}`,
    `    size: ${overrides.debSize ?? debBytes}`,
  )
  if (overrides.extraDebField) {
    lines.push(`    ${overrides.extraDebField}`)
  }
  lines.push(
    `path: ${overrides.legacyPath ?? channelAppImage}`,
    `sha512: ${overrides.legacySha512 ?? appImageSha512}`,
    `releaseDate: '${overrides.releaseDate ?? '2026-09-07T16:59:40.593Z'}'`,
  )
  if (overrides.extraTopLevel) {
    lines.push(overrides.extraTopLevel)
  }
  const channelFile = channelFileNameForVersion(channelVersion)
  await writeFile(path.join(directory, channelFile), `${lines.join('\n')}\n`, 'utf8')
  return {
    appImageBytes,
    appImageSha512,
    blockMapSize: realBlockMapSize,
    channelFile,
    debBytes,
    debSha512,
  }
}

test('channel derives from semver prerelease without a new dependency', () => {
  assert.equal(channelForVersion('1.2.3'), 'latest')
  assert.equal(channelForVersion('0.1.0-beta.1'), 'beta')
  assert.equal(channelForVersion('2.0.0-alpha.3'), 'alpha')
  assert.equal(channelForVersion('1.0.0-rc.1+build.5'), 'rc')
  assert.equal(channelForVersion('1.0.0-beta'), 'beta')
  assert.equal(channelFileNameForVersion('0.1.0-beta.1'), 'beta-linux.yml')
  assert.equal(channelFileNameForVersion('1.2.3'), 'latest-linux.yml')
  assert.equal(channelFileNameForVersion('1.0.0-rc.1+build.5'), 'rc-linux.yml')
})

test('non-semver versions are rejected', () => {
  for (const bad of [
    '',
    '1.0',
    'v1.2.3',
    '1.2.3-',
    '1.2.3+',
    '1.2.3-beta..1',
    '1.2.3-beta!',
    '1.2.3_beta.1',
    'latest',
  ]) {
    assert.throws(() => channelForVersion(bad), /invalid semver/, `expected ${bad} to fail`)
  }
  assert.throws(() => channelForVersion(), /invalid semver/)
})

test('constrained YAML parses the electron-builder shape', () => {
  const parsed = parseConstrainedUpdaterYaml(
    [
      'version: 0.1.0-beta.1',
      'files:',
      '  - url: TasteCode-0.1.0-beta.1-linux-x86_64.AppImage',
      '    sha512: abcDEF123+/==',
      '    size: 10',
      '    blockMapSize: 4',
      '  - url: TasteCode-0.1.0-beta.1-linux-amd64.deb',
      '    sha512: xyz789+/==',
      '    size: 8',
      'path: TasteCode-0.1.0-beta.1-linux-x86_64.AppImage',
      'sha512: abcDEF123+/==',
      "releaseDate: '2026-09-07T16:59:40.593Z'",
      '',
    ].join('\n'),
  )
  assert.equal(parsed.version, '0.1.0-beta.1')
  assert.equal(parsed.files.length, 2)
  assert.deepEqual(parsed.files[0], {
    url: 'TasteCode-0.1.0-beta.1-linux-x86_64.AppImage',
    sha512: 'abcDEF123+/==',
    size: 10,
    blockMapSize: 4,
  })
  assert.equal(parsed.path, 'TasteCode-0.1.0-beta.1-linux-x86_64.AppImage')
  assert.equal(parsed.releaseDate, '2026-09-07T16:59:40.593Z')
})

test('constrained YAML rejects unsafe and off-shape input', async (t) => {
  const valid = [
    'version: 9.9.9-beta.1',
    'files:',
    '  - url: a.AppImage',
    '    sha512: x',
    '    size: 1',
    '    blockMapSize: 1',
    '  - url: a.deb',
    '    sha512: y',
    '    size: 1',
    'path: a.AppImage',
    'sha512: x',
    "releaseDate: '2026-09-07T00:00:00.000Z'",
  ].join('\n')
  assert.doesNotThrow(() => parseConstrainedUpdaterYaml(valid))
  const cases = {
    'tabs are rejected': valid.replace('version:', '\tversion:'),
    'lone CR is rejected': `${valid}\rversion: evil`,
    'oversize is rejected': `${'version: 1.0.0\n'.padEnd(70_000, '#')}files:\n`,
    'unknown top-level is rejected': `${valid}\nreleaseNotes: hello`,
    'duplicate top-level is rejected': `${valid}\nversion: 9.9.9-beta.1`,
    'missing releaseDate is rejected': valid
      .split('\n')
      .filter((line) => !line.startsWith('releaseDate:'))
      .join('\n'),
    'bad indent is rejected': valid.replace('  - url:', '   - url:'),
    'orphan field is rejected': `    sha512: x\n${valid}`,
    'entry outside files is rejected': valid.replace('files:\n', ''),
    'duplicate size is rejected': valid.replace('    size: 1', '    size: 1\n    size: 1'),
    'non-numeric size is rejected': valid.replace('    size: 1', '    size: big'),
    'comment is rejected': valid.replace('version: 9.9.9-beta.1', 'version: 9.9.9-beta.1 # hi'),
    'anchor is rejected': valid.replace('version: 9.9.9-beta.1', 'version: &x 9.9.9-beta.1'),
    'flow is rejected': `${valid}\nfiles: {a: b}`,
  }
  for (const [name, text] of Object.entries(cases)) {
    await t.test(name, () => {
      assert.throws(() => parseConstrainedUpdaterYaml(text), /linux-updater-metadata/)
    })
  }
})

test('verified fixture passes with AppImage legacy fields', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedFixture(directory)
    const result = await verifyLinuxUpdaterMetadata(directory, {
      version,
      expectedArtifacts: expected,
    })
    assert.equal(result.channel, 'beta')
    assert.equal(result.channelFile, 'beta-linux.yml')
    assert.equal(result.metadata.version, version)
    assert.equal(result.metadata.path, appImage)
    assert.equal(result.metadata.files.length, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stable versions verify latest-linux.yml', async () => {
  const stable = '9.9.9'
  const stableAppImage = `TasteCode-${stable}-linux-x86_64.AppImage`
  const stableDeb = `TasteCode-${stable}-linux-amd64.deb`
  const directory = await fixtureDirectory()
  try {
    const appPayload = 'stable appimage\n'
    const debPayload = 'stable deb\n'
    const { binary, blockMapSize } = buildAppImageBinary(appPayload)
    await writeFile(path.join(directory, stableAppImage), binary)
    await writeFile(path.join(directory, stableDeb), debPayload, 'utf8')
    const lines = [
      `version: ${stable}`,
      'files:',
      `  - url: ${stableAppImage}`,
      `    sha512: ${sha512Buffer(binary)}`,
      `    size: ${binary.length}`,
      `    blockMapSize: ${blockMapSize}`,
      `  - url: ${stableDeb}`,
      `    sha512: ${sha512Text(debPayload)}`,
      `    size: ${Buffer.byteLength(debPayload)}`,
      `path: ${stableAppImage}`,
      `sha512: ${sha512Buffer(binary)}`,
      "releaseDate: '2026-09-07T00:00:00.000Z'",
    ]
    await writeFile(path.join(directory, 'latest-linux.yml'), `${lines.join('\n')}\n`, 'utf8')
    const result = await verifyLinuxUpdaterMetadata(directory, {
      version: stable,
      expectedArtifacts: [stableAppImage, stableDeb].sort(),
    })
    assert.equal(result.channelFile, 'latest-linux.yml')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing channel file fails closed', async () => {
  const directory = await fixtureDirectory()
  try {
    const { binary } = buildAppImageBinary(appImageContents)
    await writeFile(path.join(directory, appImage), binary)
    await writeFile(path.join(directory, deb), debContents, 'utf8')
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
      /updater metadata is missing: beta-linux\.yml/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('extra channel yml, arch leftovers, blockmap, and zip files are rejected', async (t) => {
  for (const extra of [
    'latest-linux.yml',
    'alpha-linux.yml',
    'beta-linux-arm.yml',
    'beta-linux-arm64.yml',
    'latest-linux-arm64.yml',
    `${appImage}.blockmap`,
    'extra.zip',
  ]) {
    await t.test(`rejects ${extra}`, async () => {
      const directory = await fixtureDirectory()
      try {
        await writeVerifiedFixture(directory)
        await writeFile(path.join(directory, extra), 'sidecar\n', 'utf8')
        await assert.rejects(
          verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
          /extra updater sidecars are rejected/,
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
})

test('no silent beta yml: wrong-channel file without the expected one fails', async () => {
  const directory = await fixtureDirectory()
  try {
    const { binary } = buildAppImageBinary(appImageContents)
    await writeFile(path.join(directory, 'TasteCode-9.9.9-test.1-linux-x86_64.AppImage'), binary)
    await writeFile(
      path.join(directory, 'TasteCode-9.9.9-test.1-linux-amd64.deb'),
      debContents,
      'utf8',
    )
    await writeFile(path.join(directory, 'beta-linux.yml'), 'version: wrong\n', 'utf8')
    // Version expects test-linux.yml, so beta-linux.yml is an unverified extra.
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, {
        version: '9.9.9-test.1',
        expectedArtifacts: [
          'TasteCode-9.9.9-test.1-linux-amd64.deb',
          'TasteCode-9.9.9-test.1-linux-x86_64.AppImage',
        ].sort(),
      }),
      /updater metadata is missing: test-linux\.yml/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tampered metadata content fails with precise errors', async (t) => {
  const cases = {
    'version mismatch': { yamlVersion: '9.9.9-beta.2' },
    'AppImage without blockMapSize': { omitBlockMapSize: true },
    'deb with blockMapSize': { extraDebField: 'blockMapSize: 4' },
    'legacy path points at deb': { legacyPath: deb },
    'legacy sha512 mismatch': { legacySha512: sha512Text('tampered legacy') },
    'bad releaseDate': { releaseDate: 'not-a-date' },
    'AppImage hash mismatch': { appImageSha512: sha512Text('tampered') },
    'deb size mismatch': { debSize: 1 },
    'AppImage size mismatch': { appImageSize: 1 },
    'oversized blockmap': { blockMapSize: 10_000 },
    'blockMapSize 1 cannot pass': { blockMapSize: 1 },
    'unknown top-level': { extraTopLevel: 'releaseNotes: hi' },
  }
  for (const [name, overrides] of Object.entries(cases)) {
    await t.test(name, async () => {
      const directory = await fixtureDirectory()
      try {
        await writeVerifiedFixture(directory, overrides)
        await assert.rejects(
          verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
          /linux-updater-metadata/,
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
})

test('blockmap trailer mismatch is rejected', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedFixture(directory)
    const appImagePath = path.join(directory, appImage)
    const binary = await readFile(appImagePath)
    const tampered = Buffer.from(binary)
    tampered[tampered.length - 1] ^= 0xff
    await writeFile(appImagePath, tampered)
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
      /blockmap trailer/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('blockmap deflate corruption is rejected', async () => {
  const directory = await fixtureDirectory()
  try {
    const { blockMapSize } = await writeVerifiedFixture(directory)
    const appImagePath = path.join(directory, appImage)
    const binary = await readFile(appImagePath)
    const tampered = Buffer.from(binary)
    tampered[tampered.length - 4 - blockMapSize] ^= 0xff
    await writeFile(appImagePath, tampered)
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
      /not valid deflate/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tampered artifact payload fails hash verification', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedFixture(directory)
    await writeFile(path.join(directory, deb), 'tampered after signing\n', 'utf8')
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
      /deb (size|sha512).*does not match/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('metadata file list must match exactly the two expected artifacts', async () => {
  const directory = await fixtureDirectory()
  try {
    // The yml lists a stale deb name while the directory holds the correct one.
    await writeVerifiedFixture(directory, {
      debName: 'TasteCode-0.0.0-old-linux-amd64.deb',
    })
    await writeFile(path.join(directory, 'TasteCode-0.0.0-old-linux-amd64.deb'), 'old\n', 'utf8')
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, { version, expectedArtifacts: expected }),
      /do not match expected/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('unsafe file names are rejected', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeVerifiedFixture(directory)
    await assert.rejects(
      verifyLinuxUpdaterMetadata(directory, {
        version,
        expectedArtifacts: ['../evil.AppImage', deb],
      }),
      /unsafe file name|exactly one AppImage/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('sha512 helper recomputes base64 digests', async () => {
  const directory = await fixtureDirectory()
  try {
    const filePath = path.join(directory, 'payload.bin')
    await writeFile(filePath, appImageContents, 'utf8')
    assert.equal(await sha512File(filePath), sha512Text(appImageContents))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Linux updater source still gates on appImagePath (static deb-ownership evidence)', async () => {
  await assert.doesNotReject(assertLinuxUpdaterPolicy())
  const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-updater-policy-test-'))
  try {
    const sourceDirectory = path.join(root, 'apps/desktop/src')
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(
      path.join(sourceDirectory, 'app-updater.ts'),
      'export function appOwnsUpdates() { return true }\n',
      'utf8',
    )
    await writeFile(
      path.join(sourceDirectory, 'app-updater.test.ts'),
      'expect(true).toBe(true)\n',
      'utf8',
    )
    await assert.rejects(assertLinuxUpdaterPolicy(root), /static check failed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updater policy reports unreadable roots fail-closed', async () => {
  const missing = path.join(os.tmpdir(), `tastecode-missing-${Date.now()}`)
  await assert.rejects(assertLinuxUpdaterPolicy(missing), /cannot read Linux updater/)
})

test('CLI arguments parse --dir and reject bad flags', () => {
  assert.equal(argumentsFrom(['--dir', 'release']).dir, path.resolve('release'))
  assert.equal(argumentsFrom(['--dir=/tmp/x']).dir, path.resolve('/tmp/x'))
  assert.equal(argumentsFrom(['--help']).help, true)
  assert.equal(argumentsFrom(['-h']).help, true)
  assert.throws(() => argumentsFrom(['--dir']), /--dir requires/)
  assert.throws(() => argumentsFrom(['--dir=']), /--dir requires/)
  assert.throws(() => argumentsFrom(['--bogus']), /unknown argument/)
})
