import { inflateRawSync } from 'node:zlib'
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

import {
  UPDATER_YAML_MAX_BYTES,
  assertSafeName,
  channelForVersion,
  compareAscii,
  expectedLinuxArtifactNames,
  extraUpdaterSidecars,
  fail,
  listReleaseFiles,
  parseDirArgs,
  readDesktopPackage,
  sha512File,
} from './linux-release-shared.js'

const TAG = '[linux-updater-metadata]'
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultReleaseDirectory = path.join(workspaceRoot, 'release')
const USAGE = 'node tools/scripts/linux-updater-metadata.js [--dir <releaseDir>]'
// Bounds for the embedded blockmap check. The real 0.1.0-beta.1 artifact carries
// ~236 KiB compressed / ~355 KiB JSON; the caps leave wide headroom while keeping
// a tampered blockMapSize from forcing huge allocations.
const BLOCKMAP_MAX_COMPRESSED_BYTES = 8 * 1024 * 1024
const BLOCKMAP_MAX_JSON_BYTES = 32 * 1024 * 1024

function assertCanonicalSha512(value, field) {
  const decoded =
    typeof value === 'string' && value !== '' ? Buffer.from(value, 'base64') : Buffer.alloc(0)
  if (decoded.length !== 64 || decoded.toString('base64') !== value) {
    throw fail(TAG, `bad ${field}; expected base64 SHA-512`)
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// js-yaml v4 load() is safe by default (unknown tags throw, duplicate keys
// throw), which is the same parser electron-updater relies on. The allowlisted
// shape check below rejects everything outside the exact channel file:
// version/files/path/sha512/releaseDate with two file entries.
function parseUpdaterMetadata(text, version, channelFile) {
  if (Buffer.byteLength(text, 'utf8') > UPDATER_YAML_MAX_BYTES) {
    throw fail(TAG, `updater metadata exceeds ${UPDATER_YAML_MAX_BYTES} bytes`)
  }
  let doc
  try {
    doc = yaml.load(text)
  } catch (error) {
    throw fail(TAG, `updater metadata does not parse: ${String(error).split('\n')[0]}`)
  }
  const bad = (why) => fail(TAG, `updater metadata ${why} in ${channelFile}`)
  if (!isPlainObject(doc)) throw bad('must be a mapping')
  if (Object.keys(doc).sort().join(',') !== 'files,path,releaseDate,sha512,version') {
    throw bad('must carry exactly version, files, path, sha512, releaseDate')
  }
  if (doc.version !== version) {
    throw fail(
      TAG,
      `updater metadata version ${JSON.stringify(doc.version)} does not match ${version}`,
    )
  }
  for (const field of ['path', 'sha512', 'releaseDate']) {
    if (typeof doc[field] !== 'string' || doc[field] === '') throw bad(`${field} must be a string`)
  }
  assertCanonicalSha512(doc.sha512, `legacy sha512 in ${channelFile}`)
  if (!Array.isArray(doc.files) || doc.files.length !== 2) {
    throw fail(TAG, `updater metadata must list exactly two files in ${channelFile}`)
  }
  for (const entry of doc.files) {
    if (!isPlainObject(entry)) throw bad('file entries must be mappings')
    const keys = Object.keys(entry).sort().join(',')
    if (keys !== 'blockMapSize,sha512,size,url' && keys !== 'sha512,size,url') {
      throw bad('file entries must carry url, sha512, size (plus blockMapSize for AppImage)')
    }
    if (typeof entry.url !== 'string' || entry.url === '') throw bad('file url must be a string')
    assertCanonicalSha512(entry.sha512, `file sha512 in ${channelFile}`)
    for (const key of ['size', 'blockMapSize']) {
      if (
        key in entry &&
        (typeof entry[key] !== 'number' || !Number.isSafeInteger(entry[key]) || entry[key] <= 0)
      ) {
        throw fail(TAG, `bad ${key} in ${channelFile}; expected a positive integer`)
      }
    }
  }
  return doc
}

// The AppImage carries its differential-update blockmap embedded: the final 4
// bytes are the big-endian byte length of the preceding deflateRaw-compressed
// blockmap JSON segment. Only that bounded slice is read and inflated; the
// ~230 MB artifact itself is never loaded into memory.
async function verifyEmbeddedBlockmap(appImagePath, appImageSize, blockMapSize, channelFile) {
  if (blockMapSize > BLOCKMAP_MAX_COMPRESSED_BYTES) {
    throw fail(
      TAG,
      `AppImage blockMapSize ${blockMapSize} in ${channelFile} exceeds the ` +
        `${BLOCKMAP_MAX_COMPRESSED_BYTES}-byte gate bound`,
    )
  }
  if (appImageSize < blockMapSize + 4) {
    throw fail(
      TAG,
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
      throw fail(
        TAG,
        `AppImage blockmap trailer ${trailerSize} does not match blockMapSize ` +
          `${blockMapSize} in ${channelFile}`,
      )
    }
    const segment = Buffer.alloc(blockMapSize)
    await handle.read(segment, 0, blockMapSize, appImageSize - 4 - blockMapSize)
    let inflated
    try {
      inflated = inflateRawSync(segment, { maxOutputLength: BLOCKMAP_MAX_JSON_BYTES })
    } catch {
      throw fail(TAG, `AppImage blockmap segment in ${channelFile} is not valid deflate`)
    }
    let blockmap
    try {
      blockmap = JSON.parse(inflated.toString('utf8'))
    } catch {
      throw fail(TAG, `AppImage blockmap in ${channelFile} is not valid JSON`)
    }
    const bad = `AppImage blockmap in ${channelFile} has an unexpected shape`
    if (!isPlainObject(blockmap) || blockmap.version !== '2') throw fail(TAG, bad)
    if (!Array.isArray(blockmap.files) || blockmap.files.length === 0) throw fail(TAG, bad)
    for (const file of blockmap.files) {
      if (
        !isPlainObject(file) ||
        typeof file.name !== 'string' ||
        file.name === '' ||
        !Number.isInteger(file.offset) ||
        file.offset < 0 ||
        !Array.isArray(file.checksums) ||
        file.checksums.length === 0 ||
        !file.checksums.every((entry) => typeof entry === 'string' && entry !== '') ||
        !Array.isArray(file.sizes) ||
        file.sizes.length === 0 ||
        !file.sizes.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
      ) {
        throw fail(TAG, bad)
      }
    }
  } finally {
    await handle.close()
  }
}

// Verify the channel file for version against the two expected Linux artifacts
// (exact AppImage + deb names from the desktop artifactName template). Deb
// ownership needs no check here: the desktop app-updater unit tests cover it,
// and the legacy path/sha512 fields below must select the AppImage.
export async function verifyLinuxUpdaterMetadata(
  releaseDirectory,
  { version, expectedArtifacts } = {},
) {
  if (!Array.isArray(expectedArtifacts) || expectedArtifacts.length !== 2) {
    throw fail(TAG, 'exactly two expected Linux artifacts are required')
  }
  const channel = channelForVersion(version, TAG)
  const channelFile = `${channel}-linux.yml`
  const sortedExpected = [...expectedArtifacts].sort(compareAscii)
  const appImageFile = sortedExpected.find((name) => name.endsWith('.AppImage'))
  const debFile = sortedExpected.find((name) => name.endsWith('.deb'))
  if (!appImageFile || !debFile || new Set(sortedExpected).size !== 2) {
    throw fail(TAG, 'expected artifacts must be exactly one AppImage and one deb')
  }
  for (const name of sortedExpected) assertSafeName(name, 'expected artifact', TAG)

  const actualNames = await listReleaseFiles(releaseDirectory, TAG)
  if (!actualNames.includes(channelFile)) {
    throw fail(TAG, `updater metadata is missing: ${channelFile} for version ${version}`)
  }
  const extra = extraUpdaterSidecars(actualNames, [channelFile])
  if (extra.length > 0) {
    throw fail(
      TAG,
      `extra updater sidecars are rejected: ${extra.join(', ')}; ` +
        `only ${channelFile} is verified for version ${version}`,
    )
  }

  const channelPath = path.join(releaseDirectory, channelFile)
  const channelStat = await stat(channelPath)
  if (!channelStat.isFile() || channelStat.size === 0) {
    throw fail(TAG, `updater metadata is not a readable file: ${channelFile}`)
  }
  const metadata = parseUpdaterMetadata(await readFile(channelPath, 'utf8'), version, channelFile)
  const actualFiles = metadata.files.map((entry) => entry.url).sort(compareAscii)
  if (actualFiles.join('\0') !== sortedExpected.join('\0')) {
    throw fail(
      TAG,
      `updater metadata files ${actualFiles.join(', ')} do not match ` +
        `expected ${sortedExpected.join(', ')}`,
    )
  }
  const byUrl = new Map(metadata.files.map((entry) => [entry.url, entry]))
  const appImageEntry = byUrl.get(appImageFile)
  const debEntry = byUrl.get(debFile)
  for (const entry of metadata.files)
    assertSafeName(entry.url, `updater url in ${channelFile}`, TAG)
  assertSafeName(metadata.path, `updater path in ${channelFile}`, TAG)
  if (!('blockMapSize' in appImageEntry)) {
    throw fail(TAG, `AppImage entry in ${channelFile} must carry url, sha512, size, blockMapSize`)
  }
  if ('blockMapSize' in debEntry) {
    throw fail(TAG, `deb entry in ${channelFile} must carry exactly url, sha512, size`)
  }

  const appImagePath = path.join(releaseDirectory, appImageFile)
  const sizes = new Map()
  for (const [file, entry] of [
    [appImageFile, appImageEntry],
    [debFile, debEntry],
  ]) {
    const full = path.join(releaseDirectory, file)
    let fileStat = null
    try {
      fileStat = await stat(full)
    } catch {
      // Fall through to the missing-or-empty failure below.
    }
    if (!fileStat?.isFile() || fileStat.size === 0) {
      throw fail(TAG, `release candidate is missing or empty: ${file}`)
    }
    if (entry.size !== fileStat.size) {
      throw fail(
        TAG,
        `size ${entry.size} in ${channelFile} does not match ${file} (${fileStat.size})`,
      )
    }
    sizes.set(file, fileStat.size)
  }
  const appImageSize = sizes.get(appImageFile)
  if (appImageEntry.blockMapSize >= appImageSize) {
    throw fail(
      TAG,
      `AppImage blockMapSize ${appImageEntry.blockMapSize} in ${channelFile} ` +
        `must be smaller than ${appImageFile} (${appImageSize})`,
    )
  }
  await verifyEmbeddedBlockmap(appImagePath, appImageSize, appImageEntry.blockMapSize, channelFile)
  let appImageSha512 = ''
  for (const [file, entry] of [
    [appImageFile, appImageEntry],
    [debFile, debEntry],
  ]) {
    const digest = await sha512File(path.join(releaseDirectory, file))
    if (entry.sha512 !== digest) {
      throw fail(TAG, `sha512 in ${channelFile} does not match ${file} on disk`)
    }
    if (file === appImageFile) appImageSha512 = digest
  }

  // Legacy electron-updater fields must select the AppImage, the only Linux
  // target served over the update channel.
  if (metadata.path !== appImageFile) {
    throw fail(TAG, `legacy path in ${channelFile} must point at ${appImageFile}`)
  }
  if (metadata.sha512 !== appImageSha512) {
    throw fail(TAG, `legacy sha512 in ${channelFile} must match ${appImageFile} on disk`)
  }
  if (Number.isNaN(Date.parse(metadata.releaseDate))) {
    throw fail(TAG, `bad releaseDate in ${channelFile}`)
  }

  return { channel, channelFile, channelPath, metadata }
}

async function main() {
  const options = parseDirArgs(process.argv.slice(2), {
    usage: USAGE,
    tag: TAG,
    defaultDir: defaultReleaseDirectory,
  })
  if (options.help) {
    process.stdout.write(
      'Verify Linux updater metadata against the AppImage and deb candidates.\n' +
        `Usage: ${USAGE}\n`,
    )
    return
  }
  const desktopPackage = await readDesktopPackage(workspaceRoot, TAG)
  const expectedArtifacts = expectedLinuxArtifactNames(
    {
      version: desktopPackage.version,
      artifactName: desktopPackage.build?.artifactName,
      productName: desktopPackage.productName,
      name: desktopPackage.name,
    },
    TAG,
  )
  const { channel, channelFile } = await verifyLinuxUpdaterMetadata(options.dir, {
    version: desktopPackage.version,
    expectedArtifacts,
  })
  process.stdout.write(
    `[linux-updater-metadata] verified ${channelFile} (channel ${channel}) for ${desktopPackage.version}\n`,
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
