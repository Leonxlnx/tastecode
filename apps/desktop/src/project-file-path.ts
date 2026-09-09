import path from 'node:path'
import os from 'node:os'

export function projectFilePath(value: unknown, projectRootValue: unknown): string {
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
  return candidate
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
