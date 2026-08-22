import path from 'node:path'
import os from 'node:os'

export function revealablePath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('Reveal path must be absolute')
  }
  const expanded = expandHomePath(value)
  if (!path.isAbsolute(expanded)) throw new Error('Reveal path must be absolute')
  return expanded
}

function expandHomePath(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}
