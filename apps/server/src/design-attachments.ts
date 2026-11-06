import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Names one version of an attached file: a file rewritten at the same path, such as a new
 * screenshot, is a different attachment. A file that cannot be read is named by its path.
 */
export function designAttachmentKey(file: string): string {
  const resolved = path.resolve(file)
  try {
    const { size, mtimeMs } = statSync(resolved)
    return `${resolved}\u0000${size}\u0000${mtimeMs}`
  } catch {
    return resolved
  }
}

/**
 * Tells the agent which images it already has, since they are not attached again. A provider
 * that compacts its context may drop them, so the note gives paths the agent can open again:
 * relative inside the workspace, absolute outside it.
 */
export function designAttachedBeforeNote(files: readonly string[], workspacePath: string): string {
  // Both sides canonical: on macOS a temp workspace under /var is really /private/var.
  const workspace = canonical(workspacePath)
  const paths = files
    .map((file) => {
      const resolved = canonical(file)
      const relative = path.relative(workspace, resolved)
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : resolved
    })
    .join(', ')
  return `These images were attached earlier in this chat and still apply unchanged; they are not attached again: ${paths}. If you no longer have them after a context compaction, open them from these paths.`
}

function canonical(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}
