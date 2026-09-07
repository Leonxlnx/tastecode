import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultReleaseDirectory = path.join(workspaceRoot, 'release')

// electron-builder emits one small channel file per release (beta-linux.yml for
// 0.1.0-beta.1, latest-linux.yml for stable). The parser below only accepts that
// constrained shape; it is not a general YAML parser and must stay that way.
const UPDATER_YAML_MAX_BYTES = 65_536
// Bounds for the embedded AppImage blockmap check below. The real 0.1.0-beta.1
// artifact carries ~236 KiB compressed / ~355 KiB JSON; these caps leave wide
// headroom while keeping a tampered blockMapSize from forcing huge allocations.
const BLOCKMAP_MAX_COMPRESSED_BYTES = 8 * 1024 * 1024
const BLOCKMAP_MAX_JSON_BYTES = 32 * 1024 * 1024
const SAFE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/

// Channel sidecars are x64 `<channel>-linux.yml` plus arch-specific
// `<channel>-linux-arm.yml` / `<channel>-linux-arm64.yml` leftovers.
function isChannelSidecar(fileName) {
  return /-linux(-arm64|-arm)?\.yml$/.test(fileName)
}

function compareAscii(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function updaterError(message) {
  return new Error(`[linux-updater-metadata] ${message}`)
}

// Derive the electron-builder channel from semver without a new dependency.
// Stable (no prerelease) updates through latest-linux.yml; a prerelease updates
// through <channel>-linux.yml where channel is the first prerelease identifier
// (0.1.0-beta.1 -> beta-linux.yml).
export function channelForVersion(version) {
  if (typeof version !== 'string' || version === '') {
    throw updaterError(`invalid semver version: ${JSON.stringify(version)}`)
  }
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    )
  if (!match) {
    throw updaterError(
      `invalid semver version: ${JSON.stringify(version)}; expected X.Y.Z[-prerelease][+build]`,
    )
  }
  const prerelease = match[4]
  if (!prerelease) return 'latest'
  const channel = prerelease.split('.')[0]
  if (!/^[A-Za-z0-9-]+$/.test(channel)) {
    throw updaterError(`unsafe updater channel ${JSON.stringify(channel)} in ${version}`)
  }
  return channel
}

export function channelFileNameForVersion(version) {
  return `${channelForVersion(version)}-linux.yml`
}

function assertSafeName(fileName, context) {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName !== path.basename(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    !SAFE_NAME_PATTERN.test(fileName)
  ) {
    throw updaterError(`unsafe file name ${JSON.stringify(fileName)} (${context})`)
  }
}

function parseScalar(raw, field, lineNumber) {
  const value = raw.trim()
  if (value === '') {
    throw updaterError(`missing value for ${field} on line ${lineNumber}`)
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw updaterError(`unterminated single-quoted ${field} on line ${lineNumber}`)
    }
    if (!/^'([^']|'')*'$/.test(value)) {
      throw updaterError(`bad single-quoted ${field} on line ${lineNumber}`)
    }
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw updaterError(`unterminated double-quoted ${field} on line ${lineNumber}`)
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'string') {
        throw new Error('not a string')
      }
      return parsed
    } catch {
      throw updaterError(`bad double-quoted ${field} on line ${lineNumber}`)
    }
  }
  if (/^[!&*|>{}[\]#@`,]/.test(value)) {
    throw updaterError(`unsupported ${field} on line ${lineNumber}`)
  }
  if (/[{}[\],&*!|>@`]/.test(value)) {
    throw updaterError(`unsupported ${field} on line ${lineNumber}`)
  }
  if (value.includes(' #') || value.includes(': ') || value.endsWith(':')) {
    throw updaterError(`unsupported ${field} on line ${lineNumber}`)
  }
  return value
}

// Minimal line parser for the exact shape electron-builder writes:
// version/files/path/sha512/releaseDate with two file entries. Anything else
// (anchors, tags, flow collections, comments, block scalars, tabs) is rejected.
export function parseConstrainedUpdaterYaml(text) {
  if (typeof text !== 'string') {
    throw updaterError('updater metadata must be text')
  }
  if (text.includes('\t')) {
    throw updaterError('updater metadata must not contain tabs')
  }
  if (text.length > UPDATER_YAML_MAX_BYTES) {
    throw updaterError(`updater metadata exceeds ${UPDATER_YAML_MAX_BYTES} bytes`)
  }
  const normalized = text.replaceAll('\r\n', '\n')
  if (normalized.includes('\r')) {
    throw updaterError('updater metadata must use LF line endings')
  }
  const lines = normalized.split('\n')
  let version
  let legacyPath
  let legacySha512
  let releaseDate
  const seenTop = new Set()
  let files = null
  let current = null

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const rawLine = lines[index].replace(/ +$/, '')
    if (rawLine.trim() === '') continue
    const indent = /^ */.exec(rawLine)[0].length
    const content = rawLine.slice(indent)
    if (indent !== 0 && indent !== 2 && indent !== 4) {
      throw updaterError(`unsupported indentation on line ${lineNumber}`)
    }
    if (indent === 0) {
      if (/^files:\s*$/.test(content)) {
        if (seenTop.has('files')) {
          throw updaterError(`duplicate files on line ${lineNumber}`)
        }
        seenTop.add('files')
        files = []
        current = null
        continue
      }
      const top = /^(version|path|sha512|releaseDate): (.+)$/.exec(content)
      if (!top) {
        throw updaterError(`unsupported updater metadata on line ${lineNumber}`)
      }
      const key = top[1]
      if (seenTop.has(key)) {
        throw updaterError(`duplicate ${key} on line ${lineNumber}`)
      }
      seenTop.add(key)
      const value = parseScalar(top[2], key, lineNumber)
      if (key === 'version') version = value
      else if (key === 'path') legacyPath = value
      else if (key === 'sha512') legacySha512 = value
      else releaseDate = value
      current = null
    } else if (indent === 2) {
      const entry = /^- url: (.+)$/.exec(content)
      if (!entry) {
        throw updaterError(`unsupported updater metadata on line ${lineNumber}`)
      }
      if (files === null) {
        throw updaterError(`file entry outside files on line ${lineNumber}`)
      }
      current = { url: parseScalar(entry[1], 'url', lineNumber) }
      files.push(current)
    } else {
      if (files === null || current === null) {
        throw updaterError(`orphan updater field on line ${lineNumber}`)
      }
      const field = /^(sha512|size|blockMapSize): (.+)$/.exec(content)
      if (!field) {
        throw updaterError(`unsupported updater metadata on line ${lineNumber}`)
      }
      const key = field[1]
      if (Object.hasOwn(current, key)) {
        throw updaterError(`duplicate ${key} on line ${lineNumber}`)
      }
      const value = parseScalar(field[2], key, lineNumber)
      if (key === 'size' || key === 'blockMapSize') {
        if (!/^\d+$/.test(value)) {
          throw updaterError(`bad ${key} on line ${lineNumber}; expected a decimal integer`)
        }
        const numeric = Number(value)
        if (!Number.isSafeInteger(numeric)) {
          throw updaterError(`bad ${key} on line ${lineNumber}; expected a decimal integer`)
        }
        current[key] = numeric
      } else {
        current[key] = value
      }
    }
  }

  for (const required of ['version', 'files', 'path', 'sha512', 'releaseDate']) {
    if (!seenTop.has(required)) {
      throw updaterError(`updater metadata is missing ${required}`)
    }
  }
  return { version, files, path: legacyPath, sha512: legacySha512, releaseDate }
}

export async function sha512File(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('base64')
}

function assertCanonicalSha512(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw updaterError(`bad ${field}; expected base64 SHA-512`)
  }
  let decoded
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    throw updaterError(`bad ${field}; expected base64 SHA-512`)
  }
  if (decoded.length !== 64 || decoded.toString('base64') !== value) {
    throw updaterError(`bad ${field}; expected base64 SHA-512`)
  }
}

// Static check only: appOwnsUpdates is expected to require appImagePath on
// Linux, with unit-test evidence that a packaged build without it (deb) stays
// package-owned. This does not prove runtime behavior; it fails closed when the
// source or its test move so this gate gets reviewed instead of silently
// covering deb-owned installs.
export async function assertLinuxUpdaterPolicy(root = workspaceRoot) {
  const sourcePath = path.join(root, 'apps/desktop/src/app-updater.ts')
  const testPath = path.join(root, 'apps/desktop/src/app-updater.test.ts')
  let source
  let testSource
  try {
    source = await readFile(sourcePath, 'utf8')
  } catch {
    throw updaterError(`cannot read Linux updater policy at ${sourcePath}`)
  }
  try {
    testSource = await readFile(testPath, 'utf8')
  } catch {
    throw updaterError(`cannot read Linux updater test evidence at ${testPath}`)
  }
  const ownsAppImage =
    /if\s*\(\s*options\.platform\s*===\s*['"]linux['"]\s*\)\s*return\s+Boolean\s*\(\s*options\.appImagePath\s*\)/.test(
      source,
    )
  const debOwned =
    /appOwnsUpdates\(\{\s*platform:\s*['"]linux['"],\s*packaged:\s*true\s*\}\)\s*\)\s*\.toBe\(false\)/.test(
      testSource,
    )
  if (!ownsAppImage || !debOwned) {
    throw updaterError(
      'Linux updater static check failed: expected appOwnsUpdates to require ' +
        'appImagePath on Linux, with test evidence that a packaged build without it ' +
        '(deb) stays package-owned; ' +
        'review apps/desktop/src/app-updater.ts before updating this gate',
    )
  }
}

function findExtraUpdaterSidecars(actualNames, channelFile) {
  return actualNames
    .filter((fileName) => fileName !== channelFile)
    .filter(
      (fileName) =>
        fileName.endsWith('.blockmap') || fileName.endsWith('.zip') || isChannelSidecar(fileName),
    )
    .sort(compareAscii)
}

// The AppImage carries its differential-update blockmap embedded: the final 4
// bytes are the big-endian byte length of the preceding deflateRaw-compressed
// blockmap JSON segment. Only that bounded slice is read and inflated; the
// ~230 MB artifact itself is never loaded into memory.
async function verifyEmbeddedBlockmap(appImagePath, appImageSize, blockMapSize, channelFile) {
  if (blockMapSize > BLOCKMAP_MAX_COMPRESSED_BYTES) {
    throw updaterError(
      `AppImage blockMapSize ${blockMapSize} in ${channelFile} exceeds the ` +
        `${BLOCKMAP_MAX_COMPRESSED_BYTES}-byte gate bound`,
    )
  }
  if (appImageSize < blockMapSize + 4) {
    throw updaterError(
      `AppImage blockMapSize ${blockMapSize} in ${channelFile} does not fit ` +
        `the artifact on disk (${appImageSize} bytes)`,
    )
  }
  const handle = await open(appImagePath, 'r')
  try {
    const trailer = Buffer.alloc(4)
    await handle.read(trailer, 0, 4, appImageSize - 4)
    const trailerSize = trailer.readUInt32BE(0)
    if (trailerSize !== blockMapSize) {
      throw updaterError(
        `AppImage blockmap trailer ${trailerSize} does not match blockMapSize ` +
          `${blockMapSize} in ${channelFile}`,
      )
    }
    const segment = Buffer.alloc(blockMapSize)
    await handle.read(segment, 0, blockMapSize, appImageSize - 4 - blockMapSize)
    let inflated
    try {
      inflated =
        blockMapSize === 0
          ? Buffer.alloc(0)
          : inflateRawSync(segment, { maxOutputLength: BLOCKMAP_MAX_JSON_BYTES })
    } catch {
      throw updaterError(`AppImage blockmap segment in ${channelFile} is not valid deflate`)
    }
    if (inflated.length > BLOCKMAP_MAX_JSON_BYTES) {
      throw updaterError(
        `AppImage blockmap JSON in ${channelFile} exceeds the ` +
          `${BLOCKMAP_MAX_JSON_BYTES}-byte gate bound`,
      )
    }
    let blockmap
    try {
      blockmap = JSON.parse(inflated.toString('utf8'))
    } catch {
      throw updaterError(`AppImage blockmap in ${channelFile} is not valid JSON`)
    }
    assertBlockmapShape(blockmap, channelFile)
  } finally {
    await handle.close()
  }
}

function assertBlockmapShape(blockmap, channelFile) {
  const bad = `AppImage blockmap in ${channelFile} has an unexpected shape`
  if (!blockmap || typeof blockmap !== 'object' || Array.isArray(blockmap)) {
    throw updaterError(bad)
  }
  if (blockmap.version !== '2') {
    throw updaterError(bad)
  }
  if (!Array.isArray(blockmap.files) || blockmap.files.length === 0) {
    throw updaterError(bad)
  }
  for (const file of blockmap.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw updaterError(bad)
    }
    if (typeof file.name !== 'string' || file.name === '') {
      throw updaterError(bad)
    }
    if (!Number.isInteger(file.offset) || file.offset < 0) {
      throw updaterError(bad)
    }
    if (
      !Array.isArray(file.checksums) ||
      file.checksums.length === 0 ||
      !file.checksums.every((entry) => typeof entry === 'string' && entry !== '')
    ) {
      throw updaterError(bad)
    }
    if (
      !Array.isArray(file.sizes) ||
      file.sizes.length === 0 ||
      !file.sizes.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    ) {
      throw updaterError(bad)
    }
  }
}

// Verify the channel file for version against the two expected Linux artifacts.
// expectedArtifacts must be the exact AppImage + deb file names for version
// (the caller derives them from the desktop artifactName template).
export async function verifyLinuxUpdaterMetadata(
  releaseDirectory,
  { version, expectedArtifacts, root = workspaceRoot } = {},
) {
  if (!version || typeof version !== 'string') {
    throw updaterError('a version is required')
  }
  if (!Array.isArray(expectedArtifacts) || expectedArtifacts.length !== 2) {
    throw updaterError('exactly two expected Linux artifacts are required')
  }
  const channel = channelForVersion(version)
  const channelFile = `${channel}-linux.yml`
  assertSafeName(channelFile, 'updater channel file')
  const sortedExpected = [...expectedArtifacts].sort(compareAscii)
  const appImageFile = sortedExpected.find((fileName) => fileName.endsWith('.AppImage'))
  const debFile = sortedExpected.find((fileName) => fileName.endsWith('.deb'))
  if (!appImageFile || !debFile || new Set(sortedExpected).size !== 2) {
    throw updaterError('expected artifacts must be exactly one AppImage and one deb')
  }
  for (const fileName of sortedExpected) assertSafeName(fileName, 'expected artifact')

  await assertLinuxUpdaterPolicy(root)

  let entries
  try {
    entries = await readdir(releaseDirectory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw updaterError(`release directory is missing: ${releaseDirectory}`)
    }
    throw error
  }
  const actualNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareAscii)
  if (!actualNames.includes(channelFile)) {
    throw updaterError(`updater metadata is missing: ${channelFile} for version ${version}`)
  }
  const extra = findExtraUpdaterSidecars(actualNames, channelFile)
  if (extra.length > 0) {
    throw updaterError(
      `extra updater sidecars are rejected: ${extra.join(', ')}; ` +
        `only ${channelFile} is verified for version ${version}`,
    )
  }

  const channelPath = path.join(releaseDirectory, channelFile)
  const channelStat = await stat(channelPath)
  if (!channelStat.isFile() || channelStat.size === 0) {
    throw updaterError(`updater metadata is not a readable file: ${channelFile}`)
  }
  const metadata = parseConstrainedUpdaterYaml(await readFile(channelPath, 'utf8'))
  if (metadata.version !== version) {
    throw updaterError(
      `updater metadata version ${JSON.stringify(metadata.version)} does not match ${version}`,
    )
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 2) {
    throw updaterError(`updater metadata must list exactly two files in ${channelFile}`)
  }
  const actualFiles = metadata.files.map((entry) => entry.url).sort(compareAscii)
  if (actualFiles.join('\0') !== sortedExpected.join('\0')) {
    throw updaterError(
      `updater metadata files ${actualFiles.join(', ')} do not match ` +
        `expected ${sortedExpected.join(', ')}`,
    )
  }
  const byUrl = new Map(metadata.files.map((entry) => [entry.url, entry]))
  const appImageEntry = byUrl.get(appImageFile)
  const debEntry = byUrl.get(debFile)

  for (const entry of metadata.files) assertSafeName(entry.url, `updater url in ${channelFile}`)
  assertSafeName(metadata.path, `updater path in ${channelFile}`)

  const appImageKeys = Object.keys(appImageEntry).sort(compareAscii)
  if (appImageKeys.join(',') !== 'blockMapSize,sha512,size,url') {
    throw updaterError(
      `AppImage entry in ${channelFile} must carry url, sha512, size, blockMapSize`,
    )
  }
  const debKeys = Object.keys(debEntry).sort(compareAscii)
  if (debKeys.join(',') !== 'sha512,size,url') {
    throw updaterError(`deb entry in ${channelFile} must carry exactly url, sha512, size`)
  }
  assertCanonicalSha512(appImageEntry.sha512, `AppImage sha512 in ${channelFile}`)
  assertCanonicalSha512(debEntry.sha512, `deb sha512 in ${channelFile}`)
  assertCanonicalSha512(metadata.sha512, `legacy sha512 in ${channelFile}`)
  for (const [label, size] of [
    [`AppImage size in ${channelFile}`, appImageEntry.size],
    [`deb size in ${channelFile}`, debEntry.size],
    [`AppImage blockMapSize in ${channelFile}`, appImageEntry.blockMapSize],
  ]) {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw updaterError(`bad ${label}; expected a positive integer`)
    }
  }

  // The embedded AppImage blockmap is described by blockMapSize; the 4-byte
  // big-endian trailer must equal it, and the preceding compressed segment
  // must inflate to blockmap JSON with the expected version/files shape.
  const appImagePath = path.join(releaseDirectory, appImageFile)
  const debPath = path.join(releaseDirectory, debFile)
  const [appImageStat, debStat] = await Promise.all([stat(appImagePath), stat(debPath)])
  if (!appImageStat.isFile() || appImageStat.size === 0) {
    throw updaterError(`release candidate is missing or empty: ${appImageFile}`)
  }
  if (!debStat.isFile() || debStat.size === 0) {
    throw updaterError(`release candidate is missing or empty: ${debFile}`)
  }
  if (appImageEntry.size !== appImageStat.size) {
    throw updaterError(
      `AppImage size ${appImageEntry.size} in ${channelFile} does not match ` +
        `${appImageFile} on disk (${appImageStat.size})`,
    )
  }
  if (debEntry.size !== debStat.size) {
    throw updaterError(
      `deb size ${debEntry.size} in ${channelFile} does not match ` +
        `${debFile} on disk (${debStat.size})`,
    )
  }
  if (appImageEntry.blockMapSize >= appImageStat.size) {
    throw updaterError(
      `AppImage blockMapSize ${appImageEntry.blockMapSize} in ${channelFile} ` +
        `must be smaller than ${appImageFile} (${appImageStat.size})`,
    )
  }
  await verifyEmbeddedBlockmap(
    appImagePath,
    appImageStat.size,
    appImageEntry.blockMapSize,
    channelFile,
  )
  const [appImageSha512, debSha512] = await Promise.all([
    sha512File(appImagePath),
    sha512File(debPath),
  ])
  if (appImageEntry.sha512 !== appImageSha512) {
    throw updaterError(`AppImage sha512 in ${channelFile} does not match ${appImageFile} on disk`)
  }
  if (debEntry.sha512 !== debSha512) {
    throw updaterError(`deb sha512 in ${channelFile} does not match ${debFile} on disk`)
  }

  // Legacy electron-updater fields must point at the AppImage, the only Linux
  // target that owns its updates.
  if (metadata.path !== appImageFile) {
    throw updaterError(`legacy path in ${channelFile} must point at ${appImageFile}`)
  }
  if (metadata.sha512 !== appImageSha512) {
    throw updaterError(`legacy sha512 in ${channelFile} must match ${appImageFile} on disk`)
  }
  if (Number.isNaN(Date.parse(metadata.releaseDate))) {
    throw updaterError(`bad releaseDate in ${channelFile}`)
  }

  return { channel, channelFile, channelPath, metadata }
}

const USAGE = 'node tools/scripts/linux-updater-metadata.js [--dir <releaseDir>]'

export function argumentsFrom(argv) {
  const options = { dir: defaultReleaseDirectory }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dir') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        throw updaterError(`--dir requires a non-empty path (${USAGE})`)
      }
      index += 1
      options.dir = path.resolve(value)
    } else if (argument.startsWith('--dir=')) {
      const value = argument.slice('--dir='.length)
      if (value === '') {
        throw updaterError(`--dir requires a non-empty path (${USAGE})`)
      }
      options.dir = path.resolve(value)
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw updaterError(`unknown argument: ${argument} (${USAGE})`)
    }
  }
  return options
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'Verify Linux updater metadata against the AppImage and deb candidates.\n' +
        `Usage: ${USAGE}\n`,
    )
    return
  }
  const desktopPackage = JSON.parse(
    await readFile(path.join(workspaceRoot, 'apps/desktop/package.json'), 'utf8'),
  )
  const version = desktopPackage.version
  if (!version) throw updaterError('apps/desktop/package.json has no version')
  // Reuse the canonical artifact-name expansion so this gate and the release
  // evidence never disagree about the expected file names.
  const { expectedLinuxArtifactNames } = await import('./linux-release-evidence.js')
  const expectedArtifacts = expectedLinuxArtifactNames({
    version,
    artifactName: desktopPackage.build?.artifactName,
    productName: desktopPackage.productName,
    name: desktopPackage.name,
  })
  const { channel, channelFile } = await verifyLinuxUpdaterMetadata(options.dir, {
    version,
    expectedArtifacts,
  })
  process.stdout.write(
    `[linux-updater-metadata] verified ${channelFile} (channel ${channel}) for ${version}\n`,
  )
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
