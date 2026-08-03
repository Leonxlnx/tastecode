import path from 'node:path'

export function revealablePath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('Reveal path must be absolute')
  }
  return value
}
