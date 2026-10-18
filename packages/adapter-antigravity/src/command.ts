import { existsSync } from 'node:fs'
import path from 'node:path'

/** Resolve the binary: PATH name normally, the installer's fixed Windows home
 *  as a fallback because the installing shell's PATH update needs a restart. */
export function antigravityCommand(): string {
  if (process.platform !== 'win32') return 'agy'
  const localAppData = process.env['LOCALAPPDATA']
  if (!localAppData) return 'agy.exe'
  const installed = path.join(localAppData, 'agy', 'bin', 'agy.exe')
  return existsSync(installed) ? installed : 'agy.exe'
}
