import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { channelFileNameForVersion, verifyLinuxUpdaterMetadata } from './linux-updater-metadata.js'

// Repository desktop command that produces the Linux x64 release candidates.
export const LINUX_DIST_COMMAND = 'pnpm --filter @harness/desktop dist'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultReleaseDirectory = path.join(workspaceRoot, 'release')
const defaultInventoryName = 'linux-release-evidence.json'
const defaultChecksumsName = 'SHA256SUMS-linux-x64.txt'

// Updater sidecars (*-linux.yml plus arch-specific *-linux-arm.yml /
// *-linux-arm64.yml, *.blockmap, *.zip) are rejected unless they are
// the single channel file verified by the updater-metadata gate
// (tools/scripts/linux-updater-metadata.js). The verified channel file is hashed
// and recorded below; everything else updater-shaped fails closed.

function compareAscii(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

// Electron-builder maps the x64 arch token per Linux target extension
// (builder-util getArtifactArchName): AppImage uses x86_64, deb uses amd64.
function linuxArchName(extension) {
  if (extension === 'AppImage') return 'x86_64'
  if (extension === 'deb') return 'amd64'
  throw new Error(`[linux-release-evidence] unsupported Linux target extension: ${extension}`)
}

function expandArtifactName(template, values) {
  return template.replaceAll(/\$\{([^}]+)\}/g, (match, token) => {
    if (Object.hasOwn(values, token)) return values[token]
    throw new Error(
      `[linux-release-evidence] unsupported artifactName macro \${${token}} in ${template}`,
    )
  })
}

const SAFE_ARTIFACT_PATTERN = /^[A-Za-z0-9._+-]+$/

function assertSafeArtifactName(fileName, template) {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName !== path.basename(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    !SAFE_ARTIFACT_PATTERN.test(fileName)
  ) {
    throw new Error(
      `[linux-release-evidence] unsafe artifact name ${JSON.stringify(fileName)} ` +
        `from template ${template}; artifact names must stay inside the release directory`,
    )
  }
}

// Expand the desktop artifactName template the same way electron-builder does
// for the two required x64 Linux targets. Falls back to the checked-in
// template when the desktop config does not declare one.
export function expectedLinuxArtifactNames({ version, artifactName, productName, name }) {
  if (!version || typeof version !== 'string') {
    throw new Error('[linux-release-evidence] a desktop package version is required')
  }
  const template = artifactName ?? 'TasteCode-${version}-${os}-${arch}.${ext}'
  const base = { version, os: 'linux', productName: productName ?? '', name: name ?? '' }
  return ['AppImage', 'deb']
    .map((extension) => {
      const fileName = expandArtifactName(template, {
        ...base,
        arch: linuxArchName(extension),
        ext: extension,
      })
      assertSafeArtifactName(fileName, template)
      return fileName
    })
    .sort(compareAscii)
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export function worktreePorcelainStatus(cwd, run = execFileSync) {
  return run('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
}

export function assertWorktreeClean(porcelain) {
  if (porcelain.trim() !== '') {
    const error = new Error(
      '[linux-release-evidence] worktree is dirty; commit or stash changes before attesting HEAD',
    )
    error.code = 'LINUX_EVIDENCE_DIRTY_WORKTREE'
    throw error
  }
}

function isChannelSidecar(fileName) {
  return /-linux(-arm64|-arm)?\.yml$/.test(fileName)
}

function sidecarReason(fileName, version) {
  if (fileName.endsWith('.blockmap') || fileName.endsWith('.zip') || isChannelSidecar(fileName)) {
    return 'updater sidecar rejected by the updater-metadata gate'
  }
  return `does not match current version ${version}`
}

function findRejectedSidecars(
  actualNames,
  { expected, channelFile, inventoryName, checksumsName, version },
) {
  const allowed = new Set([...expected, channelFile, inventoryName, checksumsName])
  return actualNames
    .filter((fileName) => !allowed.has(fileName))
    .filter(
      (fileName) =>
        fileName.endsWith('.AppImage') ||
        fileName.endsWith('.deb') ||
        fileName.endsWith('.blockmap') ||
        fileName.endsWith('.zip') ||
        isChannelSidecar(fileName) ||
        fileName.startsWith('TasteCode-'),
    )
    .map((fileName) => `${fileName} (${sidecarReason(fileName, version)})`)
    .sort(compareAscii)
}

export async function collectLinuxReleaseEvidence(
  releaseDirectory,
  { version, commit },
  options = {},
) {
  const {
    desktopPackage,
    inventoryName = defaultInventoryName,
    checksumsName = defaultChecksumsName,
  } = options
  if (!version) throw new Error('[linux-release-evidence] version is required')
  if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) {
    throw new Error(
      '[linux-release-evidence] a full 40-character git commit is required; ' +
        'rebuild from a committed checkout and retry',
    )
  }
  const resolvedDesktop =
    desktopPackage ??
    JSON.parse(await readFile(path.join(workspaceRoot, 'apps/desktop/package.json'), 'utf8'))
  const expected = expectedLinuxArtifactNames({
    version,
    artifactName: resolvedDesktop.build?.artifactName,
    productName: resolvedDesktop.productName,
    name: resolvedDesktop.name,
  })
  // The channel file is derived from semver prerelease (beta-linux.yml for
  // 0.1.0-beta.1, latest-linux.yml for stable) and must be verified by the
  // updater-metadata gate; it is never silently ignored.
  const channelFile = channelFileNameForVersion(version)
  const entries = await readdir(releaseDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `[linux-release-evidence] release directory is missing: ${releaseDirectory} ` +
          `(${LINUX_DIST_COMMAND} builds the Linux release candidates first)`,
      )
    }
    throw error
  })
  const actualNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareAscii)

  const actual = new Set(actualNames)
  const missing = [
    ...expected.filter((fileName) => !actual.has(fileName)),
    ...(actual.has(channelFile) ? [] : [channelFile]),
  ]
  const rejected = findRejectedSidecars(actualNames, {
    expected,
    channelFile,
    inventoryName,
    checksumsName,
    version,
  })
  if (missing.length > 0 || rejected.length > 0) {
    const details = [
      ...missing.map((fileName) => `missing: ${fileName}`),
      ...rejected.map((entry) => `rejected: ${entry}`),
    ]
    throw new Error(
      `[linux-release-evidence] release directory ${releaseDirectory} must contain exactly ` +
        `${[...expected, channelFile].join(', ')}; ${details.join('; ')}. ` +
        `Rebuild both x64 targets with ${LINUX_DIST_COMMAND}, then remove stale files. ` +
        `Updater sidecars (*-linux.yml, *-linux-arm.yml, *-linux-arm64.yml, *.blockmap, *.zip) ` +
        `are rejected unless they are ` +
        `the verified ${channelFile}; verification lives in tools/scripts/linux-updater-metadata.js.`,
    )
  }

  // Content verification recomputes SHA-512/size, checks the embedded blockmap
  // trailer/segment/shape and legacy AppImage fields, and runs the static Linux
  // updater check (deb stays package-owned in source/test evidence). Only a
  // gate-verified file is recorded; this states the static evidence, not a
  // runtime update guarantee.
  await verifyLinuxUpdaterMetadata(releaseDirectory, {
    version,
    expectedArtifacts: expected,
  })

  const artifacts = []
  for (const fileName of expected) {
    const filePath = path.join(releaseDirectory, fileName)
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      throw new Error(`[linux-release-evidence] not a file: ${filePath}`)
    }
    if (fileStat.size === 0) {
      throw new Error(
        `[linux-release-evidence] release candidate is empty: ${fileName} ` +
          `(rebuild with ${LINUX_DIST_COMMAND} and retry)`,
      )
    }
    artifacts.push({ file: fileName, bytes: fileStat.size, sha256: await sha256File(filePath) })
  }
  artifacts.sort((left, right) => compareAscii(left.file, right.file))

  const channelPath = path.join(releaseDirectory, channelFile)
  const channelStat = await stat(channelPath)
  if (!channelStat.isFile() || channelStat.size === 0) {
    throw new Error(`[linux-release-evidence] verified updater metadata is missing: ${channelFile}`)
  }
  const updaterMetadata = {
    file: channelFile,
    bytes: channelStat.size,
    sha256: await sha256File(channelPath),
  }

  const inventory = {
    artifacts,
    commit: commit.toLowerCase(),
    schemaVersion: 2,
    updaterMetadata,
    version,
  }
  const checksumText =
    `${artifacts.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n')}\n` +
    `${updaterMetadata.sha256}  ${updaterMetadata.file}\n`
  return { expected, channelFile, inventory, checksumText }
}

let tempFileCounter = 0

async function writeFileAtomic(finalPath, contents) {
  const tempPath = `${finalPath}.tmp-${process.pid}-${tempFileCounter++}`
  try {
    await writeFile(tempPath, contents, 'utf8')
    await rename(tempPath, finalPath)
  } finally {
    await rm(tempPath, { force: true })
  }
}

async function removeStaleTempFiles(releaseDirectory, finalName) {
  const prefix = `${finalName}.tmp-`
  let entries
  try {
    entries = await readdir(releaseDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries.filter((fileName) => fileName.startsWith(prefix))) {
    await rm(path.join(releaseDirectory, entry), { force: true })
  }
}

export async function writeLinuxReleaseEvidence(
  releaseDirectory,
  {
    version,
    commit,
    inventoryName = defaultInventoryName,
    checksumsName = defaultChecksumsName,
    desktopPackage,
  } = {},
) {
  await removeStaleTempFiles(releaseDirectory, inventoryName)
  await removeStaleTempFiles(releaseDirectory, checksumsName)
  const { inventory, checksumText } = await collectLinuxReleaseEvidence(
    releaseDirectory,
    { version, commit },
    { desktopPackage, inventoryName, checksumsName },
  )
  await mkdir(releaseDirectory, { recursive: true })
  const inventoryPath = path.join(releaseDirectory, inventoryName)
  const checksumsPath = path.join(releaseDirectory, checksumsName)
  // Keys are inserted in sorted order so repeated runs are byte-identical.
  const ordered = {
    artifacts: inventory.artifacts,
    commit: inventory.commit,
    schemaVersion: inventory.schemaVersion,
    updaterMetadata: inventory.updaterMetadata,
    version: inventory.version,
  }
  // Checksums first, inventory last: the inventory is the completion marker.
  await writeFileAtomic(checksumsPath, checksumText)
  await writeFileAtomic(inventoryPath, `${JSON.stringify(ordered, null, 2)}\n`)
  return { inventoryPath, checksumsPath, inventory }
}

const USAGE = 'node tools/scripts/linux-release-evidence.js [--dir <releaseDir>]'

export function argumentsFrom(argv) {
  const options = { dir: defaultReleaseDirectory }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dir') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        throw new Error(`[linux-release-evidence] --dir requires a non-empty path (${USAGE})`)
      }
      index += 1
      options.dir = path.resolve(value)
    } else if (argument.startsWith('--dir=')) {
      const value = argument.slice('--dir='.length)
      if (value === '') {
        throw new Error(`[linux-release-evidence] --dir requires a non-empty path (${USAGE})`)
      }
      options.dir = path.resolve(value)
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`[linux-release-evidence] unknown argument: ${argument} (${USAGE})`)
    }
  }
  return options
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'Validate Linux x64 AppImage/deb release candidates and write evidence files.\n' +
        `Usage: ${USAGE}\n`,
    )
    return
  }
  const desktopPackage = JSON.parse(
    await readFile(path.join(workspaceRoot, 'apps/desktop/package.json'), 'utf8'),
  )
  const version = desktopPackage.version
  if (!version) throw new Error('[linux-release-evidence] apps/desktop/package.json has no version')
  let porcelain
  try {
    porcelain = worktreePorcelainStatus(workspaceRoot)
  } catch {
    throw new Error(
      '[linux-release-evidence] cannot inspect the git worktree; run from a git checkout',
    )
  }
  assertWorktreeClean(porcelain)
  let commit
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    }).trim()
  } catch {
    throw new Error(
      '[linux-release-evidence] cannot determine the git commit; run from a git checkout with HEAD',
    )
  }
  const { inventoryPath, checksumsPath } = await writeLinuxReleaseEvidence(options.dir, {
    version,
    commit,
    desktopPackage,
  })
  process.stdout.write(
    `[linux-release-evidence] validated ${version} at ${commit}: ${inventoryPath} ${checksumsPath}\n` +
      '[linux-release-evidence] evidence only; this does not prove installation, signing, or compositor behavior\n',
  )
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = error?.code === 'LINUX_EVIDENCE_DIRTY_WORKTREE' ? 2 : 1
  })
}
