import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const SECRET_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
])
const SECRET_FILE_NAMES = new Set([
  '.boto',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '_netrc',
  'application_default_credentials.json',
  'credentials.json',
  'credentials.tfrc.json',
  'id_dsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
  'id_rsa',
])
const SECRET_PATH_COMPONENT_SEQUENCES = [
  ['.config', 'gcloud'],
  ['appdata', 'roaming', 'gcloud'],
  ['library', 'application support', 'gcloud'],
] as const

export function existingWorkspacePath(
  workspace: string,
  relativePath: string,
  directory: boolean,
): string {
  const target = contained(workspace, relativePath)
  const real = realpathSync(target)
  assertContained(realpathSync(workspace), real)
  const stats = statSync(real)
  if (directory ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(directory ? 'path must be a directory' : 'path must be a file')
  }
  return real
}

export function writableWorkspacePath(workspace: string, relativePath: string): string {
  const target = contained(workspace, relativePath)
  const realWorkspace = realpathSync(workspace)
  assertPublicWorkspacePath(target)
  if (existsSync(target)) {
    const realTarget = realpathSync(target)
    assertContained(realWorkspace, realTarget)
    assertPublicWorkspacePath(realTarget)
  }
  let ancestor = path.dirname(target)
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    // `\\server\share` and `Z:\` are their own dirname. On a network share or
    // removable drive that disconnects mid-session this spun forever — and it
    // is synchronous on the main thread, so it took every session with it.
    if (parent === ancestor) throw new Error('workspace is unavailable')
    ancestor = parent
  }
  const realAncestor = realpathSync(ancestor)
  assertContained(realWorkspace, realAncestor)
  assertPublicWorkspacePath(realAncestor)
  return target
}

export function assertPublicWorkspacePath(target: string): void {
  if (isSecretWorkspacePath(target)) {
    throw new Error('credential files are not available')
  }
}

/** Backward-compatible name for callers that accept files only. */
export function assertPublicWorkspaceFile(file: string): void {
  assertPublicWorkspacePath(file)
}

export function isSecretWorkspacePath(target: string): boolean {
  const components = pathComponents(target)
  if (components.some(isSecretWorkspaceName)) return true

  return SECRET_PATH_COMPONENT_SEQUENCES.some((sequence) =>
    components.some((_, index) =>
      sequence.every((component, offset) => components[index + offset] === component),
    ),
  )
}

export function isSecretWorkspaceName(name: string): boolean {
  const lower = name.normalize('NFC').toLowerCase()
  return (
    SECRET_DIRECTORY_NAMES.has(lower) ||
    lower === '.env' ||
    lower.startsWith('.env.') ||
    SECRET_FILE_NAMES.has(lower) ||
    /\.(?:key|p12|pem|pfx)$/.test(lower)
  )
}

function pathComponents(target: string): string[] {
  // Parse both separators on every host so persisted Windows paths remain
  // protected when inspected from macOS, and vice versa.
  return target
    .normalize('NFC')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((component) => component.toLowerCase())
}

function contained(workspace: string, relativePath: string): string {
  if (!relativePath) throw new Error('workspace path must be a string')
  if (path.isAbsolute(relativePath)) throw new Error('workspace path must be relative')
  const target = path.resolve(workspace, relativePath)
  assertContained(workspace, target)
  return target
}

function assertContained(workspace: string, target: string): void {
  const relative = path.relative(workspace, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path escapes the workspace')
  }
}
