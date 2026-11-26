import path from 'node:path'

/**
 * Claude Code takes images as blocks of the message, but any other attached
 * file only by its path. Those paths go at the end of the prompt text, and a
 * saved prompt is read back the same way, so a chat's own history shows the
 * prompt and its files as they were sent.
 */
const ATTACHED_FILES_HEADING = '\n\nAttached file paths:\n'

/** The prompt text Claude gets: the words, then the path of each file that is no image. */
export function withAttachedFilePaths(text: string, files: readonly string[]): string {
  return files.length
    ? `${text}${ATTACHED_FILES_HEADING}${files.map((file) => `- ${JSON.stringify(file)}`).join('\n')}`
    : text
}

/** A saved prompt apart: what the user wrote, and the files that went by path. */
export type SavedPromptParts = { text: string; files: string[] }

/**
 * The words and the file paths of a saved prompt. Text that does not end in
 * exactly the list `withAttachedFilePaths` writes is returned whole. Attached
 * files go by absolute path, so a list of other text is the user's own.
 */
export function splitAttachedFilePaths(text: string): SavedPromptParts {
  const whole: SavedPromptParts = { text, files: [] }
  const at = text.lastIndexOf(ATTACHED_FILES_HEADING)
  if (at === -1) return whole
  const files: string[] = []
  for (const line of text
    .slice(at + ATTACHED_FILES_HEADING.length)
    .replace(/\n+$/, '')
    .split('\n')) {
    if (!line.startsWith('- ')) return whole
    let file: unknown
    try {
      file = JSON.parse(line.slice(2))
    } catch {
      return whole
    }
    if (typeof file !== 'string' || !(path.posix.isAbsolute(file) || path.win32.isAbsolute(file)))
      return whole
    files.push(file)
  }
  return { text: text.slice(0, at), files }
}
