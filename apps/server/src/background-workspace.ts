import path from 'node:path'

/** Background writing (chat titles, commit messages) runs in a new temporary folder named so. */
export const BACKGROUND_WORKSPACE_PREFIX = 'tastecode-background-'

/**
 * Whether a provider session ran in one of those folders. A provider that saves every session
 * (Grok has no switch against it) keeps one per title, and none of them is the user's chat.
 * The name alone decides: the provider may record the temporary folder by another spelling.
 */
export function isBackgroundWorkspace(folder: string): boolean {
  return /^tastecode-background-[A-Za-z0-9]{6}$/.test(path.basename(folder))
}
