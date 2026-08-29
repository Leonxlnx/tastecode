import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export function packagedExecutable(directory) {
  const ignored = new Set(['chrome-sandbox', 'chrome_crashpad_handler'])
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && !ignored.has(entry.name) && !/\.so(?:\..*)?$/.test(entry.name),
    )
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => (statSync(file).mode & 0o111) !== 0)
  if (candidates.length !== 1) {
    throw new Error(`[linux-acceptance] expected one app executable, found ${candidates.length}`)
  }
  return candidates[0]
}
