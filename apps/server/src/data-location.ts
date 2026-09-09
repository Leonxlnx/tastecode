import os from 'node:os'
import path from 'node:path'
import { migrateProductFile } from './product-paths.js'

/** Shared by the server and explicit history maintenance commands. */
export function storeLocation(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['HARNESS_DATA_DIR']
  if (override)
    return migrateProductFile(
      path.join(override, 'tastecode.db'),
      path.join(override, 'harness.db'),
    )
  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? (env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share'))
  return migrateProductFile(
    path.join(base, 'TasteCode', 'tastecode.db'),
    path.join(base, 'PersonalHarness', 'harness.db'),
  )
}
