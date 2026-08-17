import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { BoundaryValue } from './boundary.js'

const ImageReferenceSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'))

/** Resolve old and current transcript references inside TasteCode's own paste folder. */
export async function viewedImagePath(
  referenceValue: BoundaryValue,
  pastedRoot: string,
): Promise<string | undefined> {
  const parsed = ImageReferenceSchema.safeParse(referenceValue)
  if (!parsed.success) return undefined
  if (path.posix.isAbsolute(parsed.data) || path.win32.isAbsolute(parsed.data)) {
    return undefined
  }

  const reference = path.normalize(parsed.data)
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
