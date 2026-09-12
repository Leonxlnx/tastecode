import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSON_SCHEMA, load } from 'js-yaml'

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
export const desktopDirectory = path.join(repositoryRoot, 'apps', 'desktop')
const platforms = {
  windows: { os: 'win', arch: 'x64', label: 'windows-x64', extensions: ['exe'] },
  macos: { os: 'mac', arch: 'arm64', label: 'macos-arm64', extensions: ['zip', 'dmg'] },
}

export function assertAssetName(name) {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,180}$/.test(name) ||
    /[ .]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error('Release asset names must be safe, flat filenames on Windows and macOS')
  }
  return name
}

export function assertCommitSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('The approved release commit must be a full lowercase 40-character SHA')
  }
  return value
}

export function createReleaseConfig(packageJson) {
  const { version, productName, name, build } = packageJson
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)
  ) {
    throw new Error('Desktop package version must be a release version')
  }
  assertAssetName(productName)
  const publish = Array.isArray(build?.publish) ? build.publish : [build?.publish]
  if (publish.length !== 1 || publish[0]?.provider !== 'generic') {
    throw new Error('Release proof requires the configured generic updater provider')
  }
  const updateUrl = new URL(publish[0].url)
  if (updateUrl.protocol !== 'https:' || updateUrl.username || updateUrl.password) {
    throw new Error('The configured update feed must use HTTPS without credentials')
  }
  const prerelease = /^\d+\.\d+\.\d+-([^+]+)/.exec(version)?.[1]
  const updaterChannel =
    publish[0].channel ??
    (build.detectUpdateChannel === false ? undefined : prerelease?.split('.')[0])
  const channel = updaterChannel ?? 'latest'
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(channel)) throw new Error('Unsupported updater channel')
  if (typeof build.artifactName !== 'string') throw new Error('Configure an explicit artifactName')
  for (const [platform, required] of [
    ['win', ['nsis']],
    ['mac', ['dmg', 'zip']],
  ]) {
    for (const key of ['publish', 'artifactName', 'detectUpdateChannel']) {
      if (build[platform]?.[key] !== undefined)
        throw new Error(`Release proof does not support a per-platform ${key} override`)
    }
    const targets = [build[platform]?.target]
      .flat()
      .map((target) => (typeof target === 'string' ? target : target?.target))
    if (required.some((target) => !targets.includes(target))) {
      throw new Error(
        `Release proof requires the configured ${platform} targets: ${required.join(', ')}`,
      )
    }
  }
  const configSha256 = createHash('sha256')
    .update(JSON.stringify({ version, productName, name, build }))
    .digest('hex')
  const config = {
    version,
    tag: `v${version}`,
    productName,
    channel,
    updaterChannel,
    prerelease: Boolean(prerelease),
    configSha256,
    publish: publish[0],
    platforms: {},
  }
  for (const [platform, detail] of Object.entries(platforms)) {
    const artifacts = detail.extensions.map((ext) => {
      const values = { version, productName, name, os: detail.os, arch: detail.arch, ext }
      return assertAssetName(
        build.artifactName.replace(/\$\{([^}]+)\}/g, (_, key) => {
          if (!Object.hasOwn(values, key))
            throw new Error(`Unsupported artifactName variable: ${key}`)
          return values[key]
        }),
      )
    })
    config.platforms[platform] = {
      ...detail,
      artifacts,
      primaryArtifact: artifacts[0],
      metadata: `${channel}${platform === 'macos' ? '-mac' : ''}.yml`,
      checksums: `SHA256SUMS-${detail.label}.txt`,
      provenance: `PROVENANCE-${detail.label}.json`,
    }
  }
  const names = releaseAssets('all', config)
  if (new Set(names.map((entry) => entry.toLowerCase())).size !== names.length) {
    throw new Error('Release configuration produces colliding artifact names')
  }
  return config
}

export const releaseConfig = createReleaseConfig(
  JSON.parse(readFileSync(path.join(desktopDirectory, 'package.json'), 'utf8')),
)

export function platformsFor(platform) {
  if (platform === 'all') return Object.keys(platforms)
  if (!Object.hasOwn(platforms, platform))
    throw new Error(`Unsupported release platform: ${platform}`)
  return [platform]
}

export function platformConfig(platform, config = releaseConfig) {
  platformsFor(platform)
  if (platform === 'all') throw new Error('Select one release platform')
  return config.platforms[platform]
}

export function releasePayloadAssets(platform, config = releaseConfig) {
  const detail = platformConfig(platform, config)
  return [...detail.artifacts.flatMap((name) => [name, `${name}.blockmap`]), detail.metadata].sort()
}

export function checksumPayloadAssets(platform, config = releaseConfig) {
  return [
    ...releasePayloadAssets(platform, config),
    platformConfig(platform, config).provenance,
  ].sort()
}

export function releaseAssets(platform = 'all', config = releaseConfig) {
  return platformsFor(platform)
    .flatMap((entry) => [
      ...checksumPayloadAssets(entry, config),
      platformConfig(entry, config).checksums,
    ])
    .sort()
}

export async function openRegularFile(filePath) {
  const before = await lstat(filePath)
  if (!before.isFile() || before.nlink !== 1 || before.size === 0) {
    throw new Error(
      `Release asset must be a nonempty regular file without links: ${path.basename(filePath)}`,
    )
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new Error(`Release asset changed while opening: ${path.basename(filePath)}`)
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function hashFile(filePath, algorithm = 'sha256', encoding = 'hex') {
  const handle = await openRegularFile(filePath)
  try {
    const hash = createHash(algorithm)
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    return hash.digest(encoding)
  } finally {
    await handle.close()
  }
}

export async function readSmallFile(filePath) {
  const handle = await openRegularFile(filePath)
  try {
    const limit = 128 * 1024
    if ((await handle.stat()).size > limit) throw new Error('Release metadata exceeds 128 KiB')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length <= limit) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit) throw new Error('Release metadata exceeds 128 KiB')
    return bytes.toString('utf8', 0, length)
  } finally {
    await handle.close()
  }
}

export function parseMetadata(text) {
  return load(text, {
    schema: JSON_SCHEMA,
    listener: (_, state) => {
      if (typeof state.anchor === 'string')
        throw new Error('Release metadata must not use YAML anchors or aliases')
    },
    onWarning: (warning) => {
      throw warning
    },
  })
}

function exactKeys(value, allowed, description) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new Error(`Unexpected ${description} fields`)
  }
}

export async function verifyReleasePayload(directory, platform, config = releaseConfig) {
  const detail = platformConfig(platform, config)
  for (const name of releasePayloadAssets(platform, config)) {
    const handle = await openRegularFile(path.join(directory, name))
    await handle.close()
  }
  const metadata = parseMetadata(await readSmallFile(path.join(directory, detail.metadata)))
  exactKeys(metadata, ['version', 'files', 'path', 'sha512', 'releaseDate'], 'updater metadata')
  if (metadata.version !== config.version)
    throw new Error(`${detail.metadata} must declare version ${config.version}`)
  if (!Array.isArray(metadata.files) || metadata.files.length !== detail.artifacts.length)
    throw new Error('Updater metadata must list exactly the platform artifacts')
  const seen = new Set()
  for (const file of metadata.files) {
    exactKeys(file, ['url', 'sha512', 'size', 'blockMapSize'], 'updater file')
    assertAssetName(file.url)
    if (!detail.artifacts.includes(file.url) || seen.has(file.url))
      throw new Error('Updater metadata contains an unexpected or duplicate artifact')
    seen.add(file.url)
    const handle = await openRegularFile(path.join(directory, file.url))
    const size = (await handle.stat()).size
    await handle.close()
    if (!Number.isSafeInteger(file.size) || file.size !== size)
      throw new Error(`Updater size mismatch for ${file.url}`)
    if (
      file.blockMapSize !== undefined &&
      (!Number.isSafeInteger(file.blockMapSize) ||
        file.blockMapSize <= 0 ||
        file.blockMapSize >= size)
    )
      throw new Error('Invalid updater blockMapSize')
    if (file.sha512 !== (await hashFile(path.join(directory, file.url), 'sha512', 'base64')))
      throw new Error(`Updater SHA-512 mismatch for ${file.url}`)
  }
  const primary = metadata.files.find((file) => file.url === detail.primaryArtifact)
  if (metadata.path !== detail.primaryArtifact || metadata.sha512 !== primary.sha512)
    throw new Error('Updater primary path or SHA-512 does not match its artifact')
  if (
    typeof metadata.releaseDate !== 'string' ||
    !Number.isFinite(Date.parse(metadata.releaseDate))
  )
    throw new Error('Updater releaseDate must be a valid date')
  return releasePayloadAssets(platform, config)
}

export async function verifyReleaseDirectory(
  directory,
  { platform = 'all', exact = true, approvedSha, config = releaseConfig } = {},
) {
  assertCommitSha(approvedSha)
  const expected = releaseAssets(platform, config)
  const rootStat = await lstat(directory)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Release directory must not be a link')
  if (exact) {
    const entries = await readdir(directory, { withFileTypes: true })
    if (
      entries.some((entry) => !entry.isFile()) ||
      JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected)
    )
      throw new Error(
        'Release directory must contain exactly the approved assets, with no directories or links',
      )
  }
  for (const current of platformsFor(platform)) {
    const detail = platformConfig(current, config)
    await verifyReleasePayload(directory, current, config)
    const provenance = JSON.parse(await readSmallFile(path.join(directory, detail.provenance)))
    exactKeys(
      provenance,
      ['schemaVersion', 'approvedSha', 'version', 'configSha256', 'platform', 'proofOnly'],
      'release provenance',
    )
    if (
      provenance.schemaVersion !== 1 ||
      provenance.approvedSha !== approvedSha ||
      provenance.version !== config.version ||
      provenance.configSha256 !== config.configSha256 ||
      provenance.platform !== current ||
      provenance.proofOnly !== true
    )
      throw new Error(
        'Release provenance does not match the approved commit and packaging configuration',
      )
    const text = await readSmallFile(path.join(directory, detail.checksums))
    const digests = new Map()
    for (const row of text.trimEnd().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(row)
      if (!match) throw new Error('Malformed SHA-256 checksum row')
      assertAssetName(match[2])
      if (digests.has(match[2])) throw new Error('Duplicate SHA-256 checksum row')
      digests.set(match[2], match[1])
    }
    if (
      JSON.stringify([...digests.keys()].sort()) !==
      JSON.stringify(checksumPayloadAssets(current, config))
    )
      throw new Error('Checksums must contain exactly the platform payload')
    for (const [name, digest] of digests) {
      if (digest !== (await hashFile(path.join(directory, name))))
        throw new Error(`Checksum mismatch for ${name}`)
    }
  }
  return expected
}

export function isMain(url) {
  return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url
}
