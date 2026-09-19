import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Whether this filesystem allows creating symbolic links at all.
 *
 * Windows without Developer Mode denies symlink creation with EPERM, so
 * symlink-based tests would fail for missing privilege rather than a broken
 * guarantee. Junction-based tests are unaffected and keep running everywhere.
 */
export function canCreateSymlinks(): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-symlink-probe-'))
  try {
    const target = path.join(root, 'target')
    writeFileSync(target, '')
    symlinkSync(target, path.join(root, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
