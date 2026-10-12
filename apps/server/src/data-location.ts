import os from 'node:os'
import path from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { acquireDataLease } from './data-lease.js'
import { DatabaseSync } from './sqlite.js'

function migrateDatabase(current: string, legacy: string): string {
  if (existsSync(current) || !existsSync(legacy)) return current
  const releaseLegacy = acquireDataLease(legacy)
  try {
    const releaseCurrent = acquireDataLease(current)
    try {
      if (existsSync(current) || !existsSync(legacy)) return current
      // Recover a crashed writer's WAL before moving the main file. A checkpoint
      // failure leaves the legacy database and its sidecars together for retry.
      const database = new DatabaseSync(legacy)
      try {
        const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
        if (Number(result?.['busy']) !== 0) {
          throw new Error('Close the legacy app before migrating its history database.')
        }
      } finally {
        database.close()
      }
      try {
        renameSync(legacy, current)
        return current
      } catch {
        return legacy
      }
    } finally {
      releaseCurrent()
    }
  } finally {
    releaseLegacy()
  }
}

/**
 * The XDG spec treats an empty or relative XDG_DATA_HOME as unset. Anything else would
 * resolve against the working directory and open a fresh database there.
 */
function absolute(directory: string | undefined): string | undefined {
  return directory && path.isAbsolute(directory) ? directory : undefined
}

/** Shared by the server and explicit history maintenance commands. */
export function storeLocation(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['HARNESS_DATA_DIR']
  if (override)
    return migrateDatabase(path.join(override, 'tastecode.db'), path.join(override, 'harness.db'))
  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? (absolute(env['APPDATA']) ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (absolute(env['XDG_DATA_HOME']) ?? path.join(home, '.local', 'share'))
  return migrateDatabase(
    path.join(base, 'TasteCode', 'tastecode.db'),
    path.join(base, 'PersonalHarness', 'harness.db'),
  )
}
