import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUILD_PROVENANCE_FILE = 'BUILD_PROVENANCE.json'
export const BUILD_PROVENANCE_SCHEMA_VERSION = 1

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function worktreePorcelainStatus(cwd, run = execFileSync) {
  return run('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
}

export function assertWorktreeClean(porcelain) {
  if (porcelain.trim() !== '') {
    const error = new Error(
      '[build-provenance] worktree is dirty; commit or stash changes before packaging',
    )
    error.code = 'BUILD_PROVENANCE_DIRTY_WORKTREE'
    throw error
  }
}

export function createBuildProvenance({ version, commit }) {
  if (typeof version !== 'string' || version === '') {
    throw new Error('[build-provenance] version is required')
  }
  if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) {
    throw new Error('[build-provenance] a full 40-character git commit is required')
  }
  return {
    commit: commit.toLowerCase(),
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    version,
  }
}

export async function writeBuildProvenance({ root = workspaceRoot, run = execFileSync } = {}) {
  assertWorktreeClean(worktreePorcelainStatus(root, run))
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const desktopPackage = JSON.parse(
    await readFile(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
  )
  const provenance = createBuildProvenance({ version: desktopPackage.version, commit })
  const destination = path.join(root, 'release', 'build-provenance.json')
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  return { destination, provenance }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntryPoint) {
  writeBuildProvenance()
    .then(({ destination, provenance }) => {
      process.stdout.write(`[build-provenance] wrote ${provenance.commit}: ${destination}\n`)
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
