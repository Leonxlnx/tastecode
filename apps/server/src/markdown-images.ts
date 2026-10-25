import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `![alt](destination "title")`, with the destination bare or in angle brackets.
const MARKDOWN_IMAGE = /!\[(?:[^\]\\\n]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g

/**
 * The files on this computer a reply shows as Markdown images, as absolute
 * paths. Agents show their screenshots this way, by path or `file:` URL.
 */
export function markdownImagePaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const file = localImagePath(match[1] ?? match[2] ?? '')
    if (file) paths.push(file)
  }
  return paths
}

/** An image source as an absolute path on this computer; nothing for a web address. */
export function localImagePath(source: string): string | undefined {
  if (/^file:/i.test(source)) {
    try {
      return fileURLToPath(source)
    } catch {
      return undefined
    }
  }
  let decoded = source
  try {
    decoded = decodeURIComponent(source)
  } catch {
    // A stray % in a real file name: the source is the path as written.
  }
  // `//host/picture.png` is a web address without its scheme, not a path.
  if (decoded.startsWith('//')) return undefined
  return path.isAbsolute(decoded) ? decoded : undefined
}

/** Whether a chat's reply shows this file as an image, however it spelled the path. */
export function showsImage(text: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false
  const wanted = path.resolve(file)
  return markdownImagePaths(text).some((shown) => path.resolve(shown) === wanted)
}
