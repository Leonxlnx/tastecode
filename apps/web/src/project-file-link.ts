import { parse, postprocess, preprocess } from 'micromark'

const INTERNAL_FILE_PREFIX = '/__harness/project-file/'

export type ProjectFileReference =
  { kind: 'safe'; path: string } | { kind: 'blocked'; path: string; reason: string }

/** Preserve real Markdown file-link destinations before the renderer blocks file: URLs. */
export function preserveProjectFileLinks(markdown: string): string {
  if (!/(?:file:\/\/|[a-z]:[\\/])/i.test(markdown)) return markdown

  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(markdown, 'utf8', true)),
  )
  const destinations: Array<{ start: number; end: number; href: string }> = []
  let linkDepth = 0

  for (const [kind, token] of events) {
    if (token.type === 'link') {
      linkDepth += kind === 'enter' ? 1 : -1
      continue
    }
    if (kind !== 'enter' || linkDepth === 0 || token.type !== 'resourceDestinationString') {
      continue
    }
    const start = token.start.offset
    const end = token.end.offset
    const href = markdown.slice(start, end)
    if (/^(?:file:\/\/|[a-z]:[\\/])/i.test(href)) {
      const literal = markdown[start - 1] === '<' && markdown[end] === '>'
      destinations.push({ start: literal ? start - 1 : start, end: literal ? end + 1 : end, href })
    }
  }

  if (destinations.length === 0) return markdown

  let result = ''
  let cursor = 0
  for (const destination of destinations) {
    result += markdown.slice(cursor, destination.start)
    result += `${INTERNAL_FILE_PREFIX}${encodeFileHref(destination.href)}`
    cursor = destination.end
  }
  return result + markdown.slice(cursor)
}

function encodeFileHref(href: string): string {
  return encodeURIComponent(href).replace(/[()]/g, (character) =>
    character === '(' ? '%28' : '%29',
  )
}

export function projectFileReference(
  href: string,
  projectPath: string,
): ProjectFileReference | undefined {
  const original = decodePreservedHref(href) ?? href
  if (!looksLocal(original)) return undefined

  const decoded = decodeLocalPath(original)
  if (decoded.kind === 'blocked') return decoded

  const candidate = stripSourceLocation(decoded.path)
  if (isWindowsRoot(projectPath)) return windowsReference(candidate, projectPath)
  if (projectPath.startsWith('/')) return posixReference(candidate, projectPath)
  return { kind: 'blocked', path: candidate, reason: 'The selected project path is invalid' }
}

function decodePreservedHref(href: string): string | undefined {
  if (!href.startsWith(INTERNAL_FILE_PREFIX)) return undefined
  try {
    return decodeURIComponent(href.slice(INTERNAL_FILE_PREFIX.length))
  } catch {
    return href.slice(INTERNAL_FILE_PREFIX.length)
  }
}

function looksLocal(href: string): boolean {
  return (
    /^file:\/\//i.test(href) ||
    /^[a-z]:[\\/]/i.test(href) ||
    href.startsWith('/') ||
    href.startsWith('\\\\')
  )
}

function decodeLocalPath(
  href: string,
): { kind: 'path'; path: string } | { kind: 'blocked'; path: string; reason: string } {
  if (!/^file:\/\//i.test(href)) return { kind: 'path', path: decode(href) }

  try {
    const url = new URL(href)
    if (url.hostname) {
      return { kind: 'blocked', path: href, reason: 'Network file links are not allowed' }
    }
    let pathname = decode(url.pathname)
    if (/^\/[a-z]:\//i.test(pathname)) pathname = pathname.slice(1)
    return { kind: 'path', path: pathname }
  } catch {
    return { kind: 'blocked', path: href, reason: 'This file link is invalid' }
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripSourceLocation(value: string): string {
  return value.replace(/:(\d+)(?::\d+)?$/, '')
}

function isWindowsRoot(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value)
}

function windowsReference(candidate: string, projectPath: string): ProjectFileReference {
  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    return { kind: 'blocked', path: candidate, reason: 'Network file links are not allowed' }
  }

  const root = normalizeWindows(projectPath)
  const path = normalizeWindows(candidate)
  if (!root || !path || !isInside(path, root, '\\', true)) {
    return { kind: 'blocked', path: candidate, reason: 'This file is outside the selected project' }
  }
  return { kind: 'safe', path }
}

function normalizeWindows(value: string): string | undefined {
  const match = /^([a-z]):[\\/](.*)$/i.exec(value)
  if (!match) return undefined
  const segments = normalizeSegments(match[2]!.split(/[\\/]+/))
  return `${match[1]!.toUpperCase()}:\\${segments.join('\\')}`
}

function posixReference(candidate: string, projectPath: string): ProjectFileReference {
  if (candidate.startsWith('//')) {
    return { kind: 'blocked', path: candidate, reason: 'Network file links are not allowed' }
  }
  if (!candidate.startsWith('/')) {
    return { kind: 'blocked', path: candidate, reason: 'This file link is not absolute' }
  }

  const root = normalizePosix(projectPath)
  const path = normalizePosix(candidate)
  if (!isInside(path, root, '/', false)) {
    return { kind: 'blocked', path: candidate, reason: 'This file is outside the selected project' }
  }
  return { kind: 'safe', path }
}

function normalizePosix(value: string): string {
  return `/${normalizeSegments(value.split('/')).join('/')}`
}

function normalizeSegments(segments: string[]): string[] {
  const result: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') result.pop()
    else result.push(segment)
  }
  return result
}

function isInside(path: string, root: string, separator: string, ignoreCase: boolean): boolean {
  const candidate = ignoreCase ? path.toLowerCase() : path
  const boundary = ignoreCase ? root.toLowerCase() : root
  const prefix = boundary.endsWith(separator) ? boundary : `${boundary}${separator}`
  return candidate === boundary || candidate.startsWith(prefix)
}
