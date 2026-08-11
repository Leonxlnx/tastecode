const INTERNAL_FILE_PREFIX = '/__harness/project-file/'

export type ProjectFileReference =
  { kind: 'safe'; path: string } | { kind: 'blocked'; path: string; reason: string }

/**
 * Markdown parsers deliberately replace file: links with `[blocked]` before
 * custom link components run. Encode only Markdown link destinations into a
 * same-origin placeholder; the renderer still validates the decoded path
 * against the selected project before making it interactive.
 */
export function preserveProjectFileLinks(markdown: string): string {
  if (!/(?:file:\/\/|[a-z]:[\\/])/i.test(markdown)) return markdown

  let cursor = 0
  let index = 0
  let lineStart = 0
  let inlineTicks = 0
  let fence: { marker: string; length: number } | undefined
  let result = ''

  while (index < markdown.length) {
    if (index === lineStart) {
      const marker = fenceMarkerAt(markdown, index)
      if (marker && (!fence || (marker.marker === fence.marker && marker.length >= fence.length))) {
        fence = fence ? undefined : marker
        const newline = markdown.indexOf('\n', index)
        if (newline < 0) break
        index = newline + 1
        lineStart = index
        continue
      }
    }

    if (fence) {
      const newline = markdown.indexOf('\n', index)
      if (newline < 0) break
      index = newline + 1
      lineStart = index
      continue
    }

    if (markdown[index] === '\n') {
      index += 1
      lineStart = index
      continue
    }

    if (markdown[index] === '`') {
      const ticks = runLength(markdown, index, '`')
      if (inlineTicks === 0) inlineTicks = ticks
      else if (inlineTicks === ticks) inlineTicks = 0
      index += ticks
      continue
    }

    if (inlineTicks === 0 && markdown[index] === ']' && markdown[index + 1] === '(') {
      const destination = linkDestinationAt(markdown, index + 2)
      if (destination && /^(?:file:\/\/|[a-z]:[\\/])/i.test(destination.href)) {
        result += markdown.slice(cursor, destination.start)
        result += `${INTERNAL_FILE_PREFIX}${encodeFileHref(destination.href)}`
        cursor = destination.end
        index = destination.end
        continue
      }
    }

    index += 1
  }

  return cursor === 0 ? markdown : result + markdown.slice(cursor)
}

function encodeFileHref(href: string): string {
  return encodeURIComponent(href).replace(/[()]/g, (character) =>
    character === '(' ? '%28' : '%29',
  )
}

function fenceMarkerAt(
  markdown: string,
  lineStart: number,
): { marker: string; length: number } | undefined {
  let index = lineStart
  while (index < lineStart + 3 && markdown[index] === ' ') index += 1
  const marker = markdown[index]
  if (marker !== '`' && marker !== '~') return undefined
  const length = runLength(markdown, index, marker)
  return length >= 3 ? { marker, length } : undefined
}

function runLength(value: string, start: number, character: string): number {
  let end = start
  while (value[end] === character) end += 1
  return end - start
}

function linkDestinationAt(
  markdown: string,
  afterOpeningParenthesis: number,
): { href: string; start: number; end: number } | undefined {
  let start = afterOpeningParenthesis
  while (markdown[start] === ' ' || markdown[start] === '\t') start += 1

  if (markdown[start] === '<') {
    const hrefStart = start + 1
    let end = hrefStart
    while (end < markdown.length && (markdown[end] !== '>' || escapedAt(markdown, end))) end += 1
    if (markdown[end] !== '>' || !validLinkTail(markdown, end + 1)) return undefined
    return { href: markdown.slice(hrefStart, end), start, end: end + 1 }
  }

  let depth = 0
  let end = start
  while (end < markdown.length) {
    const character = markdown[end]
    if (character === '\n') return undefined
    if (!escapedAt(markdown, end)) {
      if (character === '(') depth += 1
      else if (character === ')') {
        if (depth === 0) return { href: markdown.slice(start, end), start, end }
        depth -= 1
      } else if ((character === ' ' || character === '\t') && depth === 0) {
        return validLinkTail(markdown, end)
          ? { href: markdown.slice(start, end), start, end }
          : undefined
      }
    }
    end += 1
  }
  return undefined
}

function validLinkTail(markdown: string, afterDestination: number): boolean {
  let index = afterDestination
  while (markdown[index] === ' ' || markdown[index] === '\t') index += 1
  if (markdown[index] === ')') return true

  const quote = markdown[index]
  if (quote !== '"' && quote !== "'") return false
  index += 1
  while (index < markdown.length && (markdown[index] !== quote || escapedAt(markdown, index))) {
    if (markdown[index] === '\n') return false
    index += 1
  }
  if (markdown[index] !== quote) return false
  index += 1
  while (markdown[index] === ' ' || markdown[index] === '\t') index += 1
  return markdown[index] === ')'
}

function escapedAt(value: string, index: number): boolean {
  let backslashes = 0
  while (index > 0 && value[--index] === '\\') backslashes += 1
  return backslashes % 2 === 1
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
