import { existsSync, mkdirSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function migrateProductFile(current: string, legacy: string): string {
  if (existsSync(current) || !existsSync(legacy)) return current
  try {
    mkdirSync(path.dirname(current), { recursive: true })
    renameSync(legacy, current)
  } catch {
    return legacy
  }
  // A WAL sidecar holds the newest committed-but-uncheckpointed rows; leaving
  // it behind would silently drop that tail on upgrade. Each move is
  // best-effort — a stuck sidecar must not undo the database rename above.
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (existsSync(`${legacy}${suffix}`)) {
        renameSync(`${legacy}${suffix}`, `${current}${suffix}`)
      }
    } catch {
      // Keep going — losing a sidecar is bad, reverting the migration is worse.
    }
  }
  return current
}

export function configFile(name: string): string {
  const override = process.env['HARNESS_CONFIG_DIR']
  if (override) return path.join(override, name)
  return migrateProductFile(
    path.join(os.homedir(), '.tastecode', name),
    path.join(os.homedir(), '.personalharness', name),
  )
}
