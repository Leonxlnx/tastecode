import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** Resolve old and current transcript references inside TasteCode's own paste folder. */
export async function viewedImagePath(
  referenceValue: unknown,
  pastedRoot: string,
): Promise<string | undefined> {
  if (
    typeof referenceValue !== 'string' ||
    referenceValue.length === 0 ||
    referenceValue.length > 32_768 ||
    referenceValue.includes('\0')
  ) {
    return undefined
  }
  if (path.posix.isAbsolute(referenceValue) || path.win32.isAbsolute(referenceValue)) {
    return undefined
  }

  const reference = path.normalize(referenceValue)
  if (path.basename(reference) !== reference) return undefined
  return confinedFile(pastedRoot, path.join(pastedRoot, reference))
}

async function confinedFile(root: string, candidate: string): Promise<string | undefined> {
  try {
    const [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ])
    const relative = path.relative(resolvedRoot, resolvedCandidate)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined
    }
    return (await stat(resolvedCandidate)).isFile() ? resolvedCandidate : undefined
  } catch {
    return undefined
  }
}
