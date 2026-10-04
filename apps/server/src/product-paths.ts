import { existsSync, mkdirSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function migrateProductFile(current: string, legacy: string): string {
  if (existsSync(current) || !existsSync(legacy)) return current
  try {
    mkdirSync(path.dirname(current), { recursive: true })
    renameSync(legacy, current)
    return current
  } catch {
    return legacy
  }
}

export function configFile(name: string): string {
  const override = process.env['HARNESS_CONFIG_DIR']
  if (override) return path.join(override, name)
  return migrateProductFile(
    path.join(os.homedir(), '.tastecode', name),
    path.join(os.homedir(), '.personalharness', name),
  )
}
