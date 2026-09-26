import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Whether this filesystem allows creating symbolic links at all.
 *
 * Windows without Developer Mode denies symlink creation with EPERM, so a
 * symlink-based test would fail for missing privilege rather than a broken
 * guarantee. A probe keeps the test honest: it runs wherever the OS allows a
 * symlink and skips only where it does not. Junction-based tests are unaffected
 * and keep running everywhere.
 *
 * Test-only helper, exported for other packages' suites.
 */
export function canCreateSymlinks(): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-symlink-probe-'))
  try {
    const target = path.join(root, 'target')
    writeFileSync(target, '')
    symlinkSync(target, path.join(root, 'link'))
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(String(error.code))
    ) {
      return false
    }
    throw error
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
