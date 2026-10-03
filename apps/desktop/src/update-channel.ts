import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UpdateChannel } from './app-updater.js'
import { isUpdateChannel } from './preload-validation.js'

/** The channel the user chose; stable when nothing valid was saved. */
export function loadUpdateChannel(file: string): UpdateChannel {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof saved === 'object' && saved !== null && 'channel' in saved) {
      if (isUpdateChannel(saved.channel)) return saved.channel
    }
  } catch {
    // A missing or damaged file means the user never opted in to beta.
  }
  return 'stable'
}

export function saveUpdateChannel(file: string, channel: UpdateChannel): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify({ version: 1, channel })}\n`, { mode: 0o600 })
}
