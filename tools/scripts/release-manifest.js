import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const RELEASE_VERSION = '0.1.0-beta.1'
export const RELEASE_TAG = `v${RELEASE_VERSION}`

const PLATFORM_ASSETS = {
  windows: [
    `TasteCode-${RELEASE_VERSION}-win-x64.exe`,
    `TasteCode-${RELEASE_VERSION}-win-x64.exe.blockmap`,
    'beta.yml',
    'SHA256SUMS-windows-x64.txt',
  ],
  macos: [
    `TasteCode-${RELEASE_VERSION}-mac-arm64.dmg`,
    `TasteCode-${RELEASE_VERSION}-mac-arm64.dmg.blockmap`,
    `TasteCode-${RELEASE_VERSION}-mac-arm64.zip`,
    `TasteCode-${RELEASE_VERSION}-mac-arm64.zip.blockmap`,
    'beta-mac.yml',
    'SHA256SUMS-macos-arm64.txt',
  ],
}

const PLATFORM_METADATA = {
  windows: {
    name: 'beta.yml',
    primaryArtifact: `TasteCode-${RELEASE_VERSION}-win-x64.exe`,
  },
  macos: {
    name: 'beta-mac.yml',
    primaryArtifact: `TasteCode-${RELEASE_VERSION}-mac-arm64.zip`,
  },
}

const PLATFORM_CHECKSUMS = {
  windows: 'SHA256SUMS-windows-x64.txt',
  macos: 'SHA256SUMS-macos-arm64.txt',
}

function assertPlatform(platform) {
  if (platform !== 'windows' && platform !== 'macos' && platform !== 'all') {
    throw new Error(`Unsupported release platform: ${platform}`)
  }
}

function platformsFor(platform) {
  assertPlatform(platform)
  return platform === 'all' ? ['windows', 'macos'] : [platform]
}

export function releaseAssets(platform = 'all') {
  return platformsFor(platform)
    .flatMap((current) => PLATFORM_ASSETS[current])
    .sort()
}

export function checksumName(platform) {
  assertPlatform(platform)
  if (platform === 'all') throw new Error('A checksum file belongs to one platform')
  return PLATFORM_CHECKSUMS[platform]
}

export function checksumPayloadAssets(platform) {
  const checksum = checksumName(platform)
  return releaseAssets(platform).filter((name) => name !== checksum)
}

export function platformFromChecksumName(name) {
  const match = Object.entries(PLATFORM_CHECKSUMS).find(([, value]) => value === name)
  if (!match) throw new Error(`Unexpected checksum filename: ${name}`)
  return match[0]
}

export function assertReleaseTag(tag) {
  if (tag !== RELEASE_TAG) {
    throw new Error(`Release tag ${tag} does not match approved tag ${RELEASE_TAG}`)
  }
}

export function assertCommitSha(value) {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error('The approved release commit must be a full 40-character SHA')
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })

  return hash.digest('hex')
}

async function assertFilesPresent(releaseDirectory, expectedNames) {
  for (const name of expectedNames) {
    const filePath = path.join(releaseDirectory, name)
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat?.isFile()) throw new Error(`Missing release asset: ${name}`)
    if (fileStat.size === 0) throw new Error(`Release asset is empty: ${name}`)
  }
}

async function verifyUpdaterMetadata(releaseDirectory, platform) {
  const metadata = PLATFORM_METADATA[platform]
  const text = await readFile(path.join(releaseDirectory, metadata.name), 'utf8')
  const versionMatch = text.match(/^\s*version:\s*['"]?([^'"\s]+)['"]?\s*$/m)

  if (!versionMatch || versionMatch[1] !== RELEASE_VERSION) {
    throw new Error(`${metadata.name} must declare version ${RELEASE_VERSION}`)
  }

  if (!text.includes(metadata.primaryArtifact)) {
    throw new Error(`${metadata.name} does not reference ${metadata.primaryArtifact}`)
  }

  for (const match of text.matchAll(/TasteCode-[A-Za-z0-9._-]+/g)) {
    if (!match[0].startsWith(`TasteCode-${RELEASE_VERSION}-`)) {
      throw new Error(`${metadata.name} references a stale release asset: ${match[0]}`)
    }
  }
}

export async function verifyReleasePayload(releaseDirectory, platform) {
  assertPlatform(platform)
  if (platform === 'all') throw new Error('Verify release payloads one platform at a time')

  const payloadNames = checksumPayloadAssets(platform)
  await assertFilesPresent(releaseDirectory, payloadNames)
  await verifyUpdaterMetadata(releaseDirectory, platform)
  return payloadNames
}

export async function verifyChecksumFile(releaseDirectory, platform) {
  const expectedNames = checksumPayloadAssets(platform)
  const checksumFile = checksumName(platform)
  const checksumText = await readFile(path.join(releaseDirectory, checksumFile), 'utf8')
  const rows = checksumText.trim().split(/\r?\n/).filter(Boolean)
  const byName = new Map()

  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64}) {2}(.+)$/i)
    if (!match) throw new Error(`Malformed checksum row in ${checksumFile}: ${row}`)
    if (path.basename(match[2]) !== match[2]) {
      throw new Error(`Checksum filename must not contain a path: ${match[2]}`)
    }
    if (byName.has(match[2])) throw new Error(`Duplicate checksum row: ${match[2]}`)
    byName.set(match[2], match[1].toLowerCase())
  }

  const actualNames = [...byName.keys()].sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `${checksumFile} must contain exactly: ${expectedNames.join(', ')}; got: ${actualNames.join(', ')}`,
    )
  }

  for (const name of expectedNames) {
    const digest = await sha256File(path.join(releaseDirectory, name))
    if (byName.get(name) !== digest) throw new Error(`Checksum mismatch for ${name}`)
  }
}

export async function verifyReleaseDirectory(
  releaseDirectory,
  { platform = 'all', exact = true } = {},
) {
  const expectedNames = releaseAssets(platform)
  await assertFilesPresent(releaseDirectory, expectedNames)

  if (exact) {
    const actualNames = (await readdir(releaseDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()

    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(
        `Release directory must contain exactly: ${expectedNames.join(', ')}; got: ${actualNames.join(', ')}`,
      )
    }
  }

  for (const currentPlatform of platformsFor(platform)) {
    await verifyReleasePayload(releaseDirectory, currentPlatform)
    await verifyChecksumFile(releaseDirectory, currentPlatform)
  }

  return expectedNames
}
