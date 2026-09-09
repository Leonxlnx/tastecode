import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Resolve directory and file aliases before choosing a database's lock. */
export function canonicalDataPath(database: string): string {
  const resolved = path.resolve(database)
  mkdirSync(path.dirname(resolved), { recursive: true })
  return existsSync(resolved)
    ? realpathSync(resolved)
    : path.join(realpathSync(path.dirname(resolved)), path.basename(resolved))
}

/**
 * Keep an OS-backed SQLite lock for the lifetime of the core or maintenance
 * process. A crash releases the lock. The stable lock file must not be deleted:
 * replacing it would let two processes lock different files for one database.
 */
export function acquireDataLease(database: string): () => void {
  const lease = new DatabaseSync(`${canonicalDataPath(database)}.owner.sqlite`)
  try {
    lease.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (error) {
    lease.close()
    if (error instanceof Error && 'errcode' in error && error.errcode === 5) {
      throw new Error(
        'Close TasteCode and its core server before running history maintenance or opening this data folder again.',
      )
    }
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    lease.close()
  }
}
