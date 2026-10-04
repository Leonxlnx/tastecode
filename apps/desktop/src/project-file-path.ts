import path from 'node:path'
import os from 'node:os'
import { realpath } from 'node:fs/promises'

export async function projectFilePath(value: unknown, projectRootValue: unknown): Promise<string> {
  const file = safePath(value)
  const projectRoot = expandHomePath(safePath(projectRootValue))
  const flavor = windowsPath(projectRoot) ? path.win32 : path.posix

  if (!flavor.isAbsolute(projectRoot) || !flavor.isAbsolute(file)) {
    throw new Error('Project file paths must be absolute')
  }
  if (networkPath(projectRoot) || networkPath(file)) {
    throw new Error('Network file paths are not allowed')
  }

  const root = flavor.resolve(projectRoot)
  const candidate = flavor.resolve(file)
  const relative = flavor.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${flavor.sep}`) || flavor.isAbsolute(relative)) {
    throw new Error('File path is outside the selected project')
  }

  // The lexical check alone lets a symlink inside the project point outside it;
  // resolve both sides and confine again in host semantics. Paths that do not
  // exist on this host (including foreign-platform inputs) keep the lexical
  // result — they cannot be followed anyway.
  const [resolvedRoot, resolvedCandidate] = await Promise.all([
    realpath(root).catch(() => undefined),
    realpath(candidate).catch(() => undefined),
  ])
  if (resolvedRoot === undefined || resolvedCandidate === undefined) return candidate
  const resolvedRelative = path.relative(resolvedRoot, resolvedCandidate)
  if (
    resolvedRelative === '..' ||
    resolvedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolvedRelative)
  ) {
    throw new Error('File path is outside the selected project')
  }
  return resolvedCandidate
}

function expandHomePath(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function safePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes('\0')
  ) {
    throw new Error('Invalid project file path')
  }
  return value
}

function windowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value)
}

function networkPath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//')
}
