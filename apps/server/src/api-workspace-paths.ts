import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const SECRET_NAMES = new Set(['.npmrc', '.pypirc', 'credentials.json', 'id_ed25519', 'id_rsa'])

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
  if (existsSync(target)) assertContained(realWorkspace, realpathSync(target))
  let ancestor = path.dirname(target)
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    // `\\server\share` and `Z:\` are their own dirname. On a network share or
    // removable drive that disconnects mid-session this spun forever — and it
    // is synchronous on the main thread, so it took every session with it.
    if (parent === ancestor) throw new Error('workspace is unavailable')
    ancestor = parent
  }
  assertContained(realWorkspace, realpathSync(ancestor))
  return target
}

export function assertPublicWorkspaceFile(file: string): void {
  if (file.split(path.sep).some(isSecretWorkspaceName)) {
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
