import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pickedAttachment, type PickedAttachment } from './attachment-preview.js'

/**
 * Grants come only from native intake: the picker, or the path the preload read
 * from a dropped File. Never from a path string the renderer supplies.
 */
export class PickedImagePaths {
  readonly #paths = new Map<string, string>()

  async authorize(filePath: string): Promise<void> {
    if (!path.isAbsolute(filePath)) return
    try {
      const resolved = await realpath(filePath)
      if ((await stat(resolved)).isFile()) this.#paths.set(filePath, resolved)
    } catch {
      // A picker result can disappear before it is registered.
    }
  }

  async resolve(reference: string): Promise<string | undefined> {
    const authorized = this.#paths.get(reference)
    if (!authorized) return undefined
    try {
      const resolved = await realpath(reference)
      if (resolved !== authorized || !(await stat(resolved)).isFile()) return undefined
      return resolved
    } catch {
      return undefined
    }
  }
}

/** A picked or dropped file. Its image or video previews again later in this app session. */
export async function nativeAttachment(
  filePath: string,
  secret: Buffer,
  grants: PickedImagePaths,
): Promise<PickedAttachment> {
  const attachment = pickedAttachment(filePath, secret)
  if (attachment.mediaType) await grants.authorize(filePath)
  return attachment
}

/** Resolve old and current transcript references inside TasteCode's own paste folder. */
export async function viewedImagePath(
  referenceValue: unknown,
  pastedRoots: string | readonly string[],
  pickedPaths?: PickedImagePaths,
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
    return pickedPaths?.resolve(referenceValue)
  }

  const reference = path.normalize(referenceValue)
  if (path.basename(reference) !== reference) return undefined
  for (const root of typeof pastedRoots === 'string' ? [pastedRoots] : pastedRoots) {
    const file = await confinedFile(root, path.join(root, reference))
    if (file) return file
  }
  return undefined
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
