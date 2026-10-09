import { fileURLToPath } from 'node:url'

/** Whether `url` is the renderer file the app itself loaded. */
export function isRendererFileUrl(url: string, indexPath: string): boolean {
  const parsed = new URL(url)
  if (parsed.protocol !== 'file:') return false
  parsed.hash = ''
  parsed.search = ''
  return fileURLToPath(parsed) === indexPath
}
