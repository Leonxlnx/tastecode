import { createContext } from 'react'

/** The project folder of the chat on screen, for showing file paths inside it. */
export const ProjectRootContext = createContext<string | undefined>(undefined)

/**
 * A file path as the project sees it: agents such as Codex report absolute
 * paths, which repeat the project folder in every row of an edit card. A path
 * outside the project, or one that is already relative, is shown as it is.
 */
export function projectRelativePath(path: string, root: string | undefined): string {
  if (!root) return path
  const normalized = path.replaceAll('\\', '/')
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '')
  if (!base) return path
  // Windows paths compare without case; a drive letter or UNC root marks one.
  const windows = /^[A-Za-z]:\/|^\/\//.test(base)
  const prefix = `${base}/`
  const inside = windows
    ? normalized.toLowerCase().startsWith(prefix.toLowerCase())
    : normalized.startsWith(prefix)
  return inside && normalized.length > prefix.length ? normalized.slice(prefix.length) : path
}
