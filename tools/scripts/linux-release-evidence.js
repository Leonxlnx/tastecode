import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  compareAscii,
  expectedLinuxArtifactNames,
  listReleaseFiles,
  parseDirArgs,
  readDesktopPackage,
  sha256File,
} from './linux-release-shared.js'
import {
  assertWorktreeClean,
  BUILD_PROVENANCE_FILE,
  BUILD_PROVENANCE_SCHEMA_VERSION,
  worktreePorcelainStatus,
} from './build-provenance.js'

export { assertWorktreeClean, worktreePorcelainStatus } from './build-provenance.js'

const TAG = '[linux-release-evidence]'

// Repository desktop command that produces the Linux x64 release candidates.
export const LINUX_DIST_COMMAND = 'pnpm --filter @harness/desktop dist:linux'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultReleaseDirectory = path.join(workspaceRoot, 'release', 'linux-x64')
const defaultInventoryName = 'linux-release-evidence.json'
const defaultChecksumsName = 'SHA256SUMS-linux-x64.txt'
const USAGE = 'node tools/scripts/linux-release-evidence.js [--dir <releaseDir>]'

function findRejected(actualNames, { expected, inventoryName, checksumsName }) {
  const allowed = new Set([...expected, inventoryName, checksumsName])
  return actualNames.filter((name) => !allowed.has(name)).sort(compareAscii)
}

export function assertArtifactProvenance(provenance, { artifact, version, commit }) {
  if (
    provenance?.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION ||
    provenance?.version !== version ||
    typeof provenance?.commit !== 'string' ||
    provenance.commit.toLowerCase() !== commit.toLowerCase()
  ) {
    throw new Error(
      `[linux-release-evidence] ${artifact} was not built from ${commit} at version ${version}; ` +
        `rebuild both x64 targets with ${LINUX_DIST_COMMAND}`,
    )
  }
}

async function readArtifactProvenance(artifactPath, artifactName, desktopPackage) {
  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'tastecode-provenance-'))
  try {
    let provenancePath
    if (artifactName.endsWith('.AppImage')) {
      const resourcePath = path.posix.join('resources', BUILD_PROVENANCE_FILE)
      execFileSync(artifactPath, ['--appimage-extract', resourcePath], {
        cwd: extractionRoot,
        stdio: 'ignore',
        timeout: 120_000,
      })
      provenancePath = path.join(extractionRoot, 'squashfs-root', resourcePath)
    } else if (artifactName.endsWith('.deb')) {
      execFileSync('dpkg-deb', ['--extract', artifactPath, extractionRoot], {
        stdio: 'ignore',
        timeout: 120_000,
      })
      provenancePath = path.join(
        extractionRoot,
        'opt',
        desktopPackage.productName,
        'resources',
        BUILD_PROVENANCE_FILE,
      )
    } else {
      throw new Error(`[linux-release-evidence] unsupported artifact: ${artifactName}`)
    }
    return JSON.parse(await readFile(provenancePath, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[linux-release-evidence] cannot verify embedded provenance in ${artifactName}: ${detail}`,
    )
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

function normalizeDebDependency(dependency) {
  return dependency
    .trim()
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*\|\s*/g, ' | ')
}

function configuredDebDependencies(debConfig) {
  const configured = []
  if (typeof debConfig?.depends === 'string') configured.push(debConfig.depends)
  if (Array.isArray(debConfig?.depends)) configured.push(...debConfig.depends)
  const fpmArgs = Array.isArray(debConfig?.fpm) ? debConfig.fpm : []
  for (let index = 0; index < fpmArgs.length; index += 1) {
    const argument = fpmArgs[index]
    if (argument === '--depends' || argument === '-d') {
      const dependency = fpmArgs[index + 1]
      if (typeof dependency !== 'string' || dependency.trim() === '') {
        throw new Error(`[linux-release-evidence] ${argument} requires a dependency value`)
      }
      configured.push(dependency)
      index += 1
    } else if (argument.startsWith('--depends=')) {
      const dependency = argument.slice('--depends='.length)
      if (dependency.trim() === '') {
        throw new Error('[linux-release-evidence] --depends requires a dependency value')
      }
      configured.push(dependency)
    } else if (argument.startsWith('-d=')) {
      const dependency = argument.slice('-d='.length)
      if (dependency.trim() === '') {
        throw new Error('[linux-release-evidence] -d requires a dependency value')
      }
      configured.push(dependency)
    }
  }
  return configured.map(normalizeDebDependency)
}

export function assertConfiguredDebDependencies(actualDepends, debConfig = {}) {
  const configured = configuredDebDependencies(debConfig)
  const actual = new Set(actualDepends.split(',').map(normalizeDebDependency))
  for (const dependency of configured) {
    if (!actual.has(dependency)) {
      throw new Error(
        `[linux-release-evidence] deb is missing configured dependency: ${dependency}`,
      )
    }
  }
}

// Exported for programmatic callers — main() runs it, but a library consumer
// must call it explicitly; collectLinuxReleaseEvidence deliberately stays
// runnable without dpkg-deb for tests and non-deb environments.
export function verifyConfiguredDebDependencies(releaseDirectory, desktopPackage) {
  const debConfig = desktopPackage.build?.deb
  if (configuredDebDependencies(debConfig).length === 0) return
  const debName = expectedLinuxArtifactNames(
    {
      version: desktopPackage.version,
      artifactName: desktopPackage.build?.artifactName,
      productName: desktopPackage.productName,
      name: desktopPackage.name,
    },
    TAG,
  ).find((name) => name.endsWith('.deb'))
  if (!debName) {
    throw new Error('[linux-release-evidence] cannot determine the expected deb artifact name')
  }
  const debPath = path.join(releaseDirectory, debName)
  if (!existsSync(debPath)) {
    throw new Error(`[linux-release-evidence] deb is missing: ${debPath}; rebuild both x64 targets`)
  }
  let actualDepends
  try {
    actualDepends = execFileSync('dpkg-deb', ['--field', debPath, 'Depends'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
  } catch {
    throw new Error(
      '[linux-release-evidence] cannot inspect deb dependencies with dpkg-deb; install dpkg and retry',
    )
  }
  assertConfiguredDebDependencies(actualDepends, debConfig)
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
    readProvenance = readArtifactProvenance,
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
  const actualNames = await listReleaseFiles(
    releaseDirectory,
    TAG,
    ` (${LINUX_DIST_COMMAND} builds the Linux release candidates first)`,
  )

  const actual = new Set(actualNames)
  const missing = expected.filter((name) => !actual.has(name))
  const rejected = findRejected(actualNames, {
    expected,
    inventoryName,
    checksumsName,
  })
  if (missing.length > 0 || rejected.length > 0) {
    const details = [
      ...missing.map((name) => `missing: ${name}`),
      ...rejected.map((name) => `rejected: ${name}`),
    ]
    throw new Error(
      `[linux-release-evidence] release directory ${releaseDirectory} must contain exactly ` +
        `${expected.join(', ')} plus generated evidence; ${details.join('; ')}. ` +
        `Rebuild both x64 targets with ${LINUX_DIST_COMMAND}, then remove stale files. ` +
        'Linux v1 is manual-update only, so updater YAML, blockmaps, zip files, and every ' +
        'other unapproved sidecar are rejected.',
    )
  }

  const artifacts = []
  for (const name of expected) {
    const artifactPath = path.join(releaseDirectory, name)
    const fileStat = await stat(artifactPath)
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new Error(
        `[linux-release-evidence] release candidate is empty: ${name} ` +
          `(rebuild with ${LINUX_DIST_COMMAND} and retry)`,
      )
    }
    const provenance = await readProvenance(artifactPath, name, resolvedDesktop)
    assertArtifactProvenance(provenance, { artifact: name, version, commit })
    artifacts.push({
      file: name,
      bytes: fileStat.size,
      sha256: await sha256File(artifactPath),
    })
  }
  artifacts.sort((left, right) => compareAscii(left.file, right.file))

  const inventory = {
    artifacts,
    commit: commit.toLowerCase(),
    payloadProvenance: {
      artifacts: expected.toSorted(compareAscii),
      commit: commit.toLowerCase(),
      schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
      version,
    },
    schemaVersion: 4,
    updateMode: 'manual',
    version,
  }
  const checksumText = `${artifacts.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n')}\n`
  return { expected, inventory, checksumText }
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

async function writeEvidenceFile(finalPath, contents) {
  try {
    const existing = await readFile(finalPath, 'utf8')
    if (existing !== contents) {
      throw new Error(
        `[linux-release-evidence] existing Linux release evidence does not match current artifacts: ${path.basename(finalPath)}`,
      )
    }
    return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await writeFileAtomic(finalPath, contents)
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
    readProvenance,
  } = {},
) {
  await removeStaleTempFiles(releaseDirectory, inventoryName)
  await removeStaleTempFiles(releaseDirectory, checksumsName)
  const { inventory, checksumText } = await collectLinuxReleaseEvidence(
    releaseDirectory,
    { version, commit },
    { desktopPackage, inventoryName, checksumsName, readProvenance },
  )
  await mkdir(releaseDirectory, { recursive: true })
  const inventoryPath = path.join(releaseDirectory, inventoryName)
  const checksumsPath = path.join(releaseDirectory, checksumsName)
  // Keys are inserted in sorted order so repeated runs are byte-identical.
  const ordered = {
    artifacts: inventory.artifacts,
    commit: inventory.commit,
    payloadProvenance: inventory.payloadProvenance,
    schemaVersion: inventory.schemaVersion,
    updateMode: inventory.updateMode,
    version: inventory.version,
  }
  // Checksums first, inventory last: the inventory is the completion marker.
  // Existing proof is immutable unless it matches byte-for-byte.
  await writeEvidenceFile(checksumsPath, checksumText)
  await writeEvidenceFile(inventoryPath, `${JSON.stringify(ordered, null, 2)}\n`)
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
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `[linux-release-evidence] requires Linux x64, received ${process.platform} ${process.arch}`,
    )
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
  verifyConfiguredDebDependencies(options.dir, desktopPackage)
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
    process.exitCode = error?.code === 'BUILD_PROVENANCE_DIRTY_WORKTREE' ? 2 : 1
  })
}
