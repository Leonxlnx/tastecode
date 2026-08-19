import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'

const RevealPathSchema = z.string().refine((value) => !value.includes('\0'))

export function revealablePath(value: unknown): string {
  const parsed = RevealPathSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Reveal path must be absolute')
  }
  const expanded = expandHomePath(parsed.data)
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
