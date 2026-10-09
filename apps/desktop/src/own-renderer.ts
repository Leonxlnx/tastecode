import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether `url` is the renderer file the app itself loaded. Chromium reports
 * file URLs with an upper-case drive letter, while the loaded path keeps the
 * case the executable was started with (`c:\…` from a terminal), so Windows
 * compares the way its file system does: case-insensitively.
 */
export function isRendererFileUrl(
  url: string,
  indexPath: string,
  windows = process.platform === 'win32',
): boolean {
  const parsed = new URL(url)
  if (parsed.protocol !== 'file:') return false
  parsed.hash = ''
  parsed.search = ''
  const file = fileURLToPath(parsed, { windows })
  return windows ? path.win32.relative(file, indexPath) === '' : file === indexPath
}
