import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const SECRET_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.boto',
  '.git-credentials',
  'credentials.json',
  'credentials.tfrc.json',
  'application_default_credentials.json',
  '.credentials.json',
  'auth.json',
  'id_ed25519',
  'id_rsa',
  'id_ecdsa',
  'id_dsa',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  '.aws',
  '.ssh',
  '.azure',
  '.kube',
  '.gnupg',
  '.docker',
  'gcloud',
])

export function existingWorkspacePath(
  workspace: string,
  relativePath: string,
  directory: boolean,
): string {
  const target = contained(workspace, relativePath)
  const real = realpathSync(target)
  const realWorkspace = realpathSync(workspace)
  assertContained(realWorkspace, real)
  assertPublicWorkspaceFile(target, workspace)
  assertPublicWorkspaceFile(real, realWorkspace)
  const stats = statSync(real)
  if (directory ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(directory ? 'path must be a directory' : 'path must be a file')
  }
  return real
}

export function writableWorkspacePath(workspace: string, relativePath: string): string {
  const target = contained(workspace, relativePath)
  const realWorkspace = realpathSync(workspace)
  assertPublicWorkspaceFile(target, workspace)
  if (existsSync(target)) {
    const real = realpathSync(target)
    assertContained(realWorkspace, real)
    assertPublicWorkspaceFile(real, realWorkspace)
    return real
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
  const real = path.resolve(realpathSync(ancestor), path.relative(ancestor, target))
  assertContained(realWorkspace, real)
  assertPublicWorkspaceFile(real, realWorkspace)
  return real
}

/**
 * Only the workspace's own name and the part below it are checked: a project
 * that merely lives under a folder such as `gcloud` or `.docker` is not itself a
 * credential, but a workspace opened directly on `~/.aws` or `~/.kube` still is.
 */
export function assertPublicWorkspaceFile(file: string, workspace?: string): void {
  const relative = workspace === undefined ? undefined : path.relative(workspace, file)
  const inside =
    relative !== undefined &&
    !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  const checked = inside
    ? [path.basename(workspace!), ...relative.split(path.sep)]
    : file.split(path.sep)
  if (checked.some(isSecretWorkspaceName)) {
    throw new Error('credential files are not available')
  }
}

export function isSecretWorkspaceName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === '.git' ||
    lower === '.env' ||
    lower.startsWith('.env.') ||
    SECRET_NAMES.has(lower) ||
    /\.(?:key|p12|pem|pfx)$/.test(lower)
  )
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
