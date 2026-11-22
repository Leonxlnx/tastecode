import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Background writing (chat titles, commit messages) runs in a new temporary folder named so. */
export const BACKGROUND_WORKSPACE_PREFIX = 'tastecode-background-'

/**
 * Whether a provider session ran in one of those folders. A provider that saves every session
 * (Grok has no switch against it) keeps one per title, and none of them is the user's chat.
 * The name has to match and the folder has to be in the system's temporary folder: a project
 * of the user's can carry the same name. The provider may record the temporary folder by
 * another spelling (a link such as macOS's /var, or a Windows short name), so the folder it
 * sits in is compared once resolved; that one is still there after the session's own is gone.
 */
export function isBackgroundWorkspace(folder: string, temporary: string = os.tmpdir()): boolean {
  if (!/^tastecode-background-[A-Za-z0-9]{6}$/.test(path.basename(folder))) return false
  const parent = resolvedFolder(path.dirname(folder))
  const temp = resolvedFolder(temporary)
  if (parent === undefined || temp === undefined) return false
  // Windows and macOS compare folder names without case by default.
  return process.platform === 'linux'
    ? parent === temp
    : parent.toLowerCase() === temp.toLowerCase()
}

function resolvedFolder(folder: string): string | undefined {
  try {
    return realpathSync.native(folder)
  } catch {
    return undefined
  }
}
