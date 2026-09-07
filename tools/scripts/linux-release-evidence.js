import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  channelFileNameForVersion,
  compareAscii,
  expectedLinuxArtifactNames,
  isChannelSidecar,
  listReleaseFiles,
  parseDirArgs,
  readDesktopPackage,
  sha256File,
} from './linux-release-shared.js'
import { verifyLinuxUpdaterMetadata } from './linux-updater-metadata.js'

const TAG = '[linux-release-evidence]'

// Repository desktop command that produces the Linux x64 release candidates.
export const LINUX_DIST_COMMAND = 'pnpm --filter @harness/desktop dist'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultReleaseDirectory = path.join(workspaceRoot, 'release')
const defaultInventoryName = 'linux-release-evidence.json'
const defaultChecksumsName = 'SHA256SUMS-linux-x64.txt'
const USAGE = 'node tools/scripts/linux-release-evidence.js [--dir <releaseDir>]'

// Updater sidecars (*-linux.yml plus *-linux-arm/arm64.yml, *.blockmap, *.zip)
// are rejected unless they are the single channel file verified by the
// updater-metadata gate. The verified file is hashed and recorded below;
// everything else updater-shaped fails closed.
function findRejected(
  actualNames,
  { expected, channelFile, inventoryName, checksumsName, version },
) {
  const allowed = new Set([...expected, channelFile, inventoryName, checksumsName])
  const reason = (name) =>
    name.endsWith('.blockmap') || name.endsWith('.zip') || isChannelSidecar(name)
      ? 'updater sidecar rejected by the updater-metadata gate'
      : `does not match current version ${version}`
  return actualNames
    .filter((name) => !allowed.has(name))
    .filter(
      (name) =>
        name.endsWith('.AppImage') ||
        name.endsWith('.deb') ||
        name.endsWith('.blockmap') ||
        name.endsWith('.zip') ||
        isChannelSidecar(name) ||
        name.startsWith('TasteCode-'),
    )
    .map((name) => `${name} (${reason(name)})`)
    .sort(compareAscii)
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
  const resolvedDesktop = desktopPackage ?? (await readDesktopPackage(workspaceRoot, TAG))
  const expected = expectedLinuxArtifactNames(
    {
      version,
      artifactName: resolvedDesktop.build?.artifactName,
      productName: resolvedDesktop.productName,
      name: resolvedDesktop.name,
    },
    TAG,
  )
  // The channel file (beta-linux.yml for 0.1.0-beta.1, latest-linux.yml for
  // stable) must be verified by the updater-metadata gate; never silently ignored.
  const channelFile = channelFileNameForVersion(version, TAG)
  const actualNames = await listReleaseFiles(
    releaseDirectory,
    TAG,
    ` (${LINUX_DIST_COMMAND} builds the Linux release candidates first)`,
  )

  const actual = new Set(actualNames)
  const missing = [
    ...expected.filter((name) => !actual.has(name)),
    ...(actual.has(channelFile) ? [] : [channelFile]),
  ]
  const rejected = findRejected(actualNames, {
    expected,
    channelFile,
    inventoryName,
    checksumsName,
    version,
  })
  if (missing.length > 0 || rejected.length > 0) {
    const details = [
      ...missing.map((name) => `missing: ${name}`),
      ...rejected.map((entry) => `rejected: ${entry}`),
    ]
    throw new Error(
      `[linux-release-evidence] release directory ${releaseDirectory} must contain exactly ` +
        `${[...expected, channelFile].join(', ')}; ${details.join('; ')}. ` +
        `Rebuild both x64 targets with ${LINUX_DIST_COMMAND}, then remove stale files. ` +
        `Updater sidecars (*-linux.yml, *-linux-arm.yml, *-linux-arm64.yml, *.blockmap, *.zip) ` +
        `are rejected unless they are the verified ${channelFile}.`,
    )
  }

  // Content verification recomputes SHA-512/size, checks the embedded blockmap
  // trailer/segment/shape and the legacy AppImage fields. Only a gate-verified
  // file is recorded; this states the static evidence, not a runtime guarantee.
  await verifyLinuxUpdaterMetadata(releaseDirectory, { version, expectedArtifacts: expected })

  const artifacts = []
  for (const name of expected) {
    const fileStat = await stat(path.join(releaseDirectory, name))
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new Error(
        `[linux-release-evidence] release candidate is empty: ${name} ` +
          `(rebuild with ${LINUX_DIST_COMMAND} and retry)`,
      )
    }
    artifacts.push({
      file: name,
      bytes: fileStat.size,
      sha256: await sha256File(path.join(releaseDirectory, name)),
    })
  }
  artifacts.sort((left, right) => compareAscii(left.file, right.file))

  const channelStat = await stat(path.join(releaseDirectory, channelFile))
  if (!channelStat.isFile() || channelStat.size === 0) {
    throw new Error(`[linux-release-evidence] verified updater metadata is missing: ${channelFile}`)
  }
  const updaterMetadata = {
    file: channelFile,
    bytes: channelStat.size,
    sha256: await sha256File(path.join(releaseDirectory, channelFile)),
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
  for (const entry of entries.filter((name) => name.startsWith(prefix))) {
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

async function main() {
  const options = parseDirArgs(process.argv.slice(2), {
    usage: USAGE,
    tag: TAG,
    defaultDir: defaultReleaseDirectory,
  })
  if (options.help) {
    process.stdout.write(
      'Validate Linux x64 AppImage/deb release candidates and write evidence files.\n' +
        `Usage: ${USAGE}\n`,
    )
    return
  }
  const desktopPackage = await readDesktopPackage(workspaceRoot, TAG)
  const version = desktopPackage.version
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
