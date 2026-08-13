import { parse, postprocess, preprocess } from 'micromark'
import { decodeString } from 'micromark-util-decode-string'

const INTERNAL_FILE_PREFIX = '/__harness/project-file/'

export type ProjectFileReference =
  { kind: 'safe'; path: string } | { kind: 'blocked'; path: string; reason: string }

/** Preserve real Markdown file-link destinations before the renderer blocks file: URLs. */
export function preserveProjectFileLinks(markdown: string): string {
  const parseWindow = projectFileLinkParseWindow(markdown)
  if (parseWindow.end === 0) return markdown

  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(markdown.slice(0, parseWindow.end), 'utf8', true)),
  )
  const destinations: Array<{ start: number; end: number; href: string }> = []
  const owners: Array<'link' | 'image'> = []

  for (const [kind, token] of events) {
    if (token.type === 'link' || token.type === 'image') {
      if (kind === 'enter') owners.push(token.type)
      else owners.pop()
      continue
    }
    if (
      kind !== 'enter' ||
      owners.at(-1) !== 'link' ||
      token.type !== 'resourceDestinationString'
    ) {
      continue
    }
    const start = token.start.offset
    const end = token.end.offset
    const href = decodeString(markdown.slice(start, end))
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

export function projectFileLinkParseWindow(markdown: string): { end: number; scanned: number } {
  const candidatePattern = /\]\(\s*<?(?:file:\/\/|[a-z]:[\\/])/gi
  let parseEnd = 0
  let scanned = 0
  let remainingScan = markdown.length
  for (const candidate of markdown.matchAll(candidatePattern)) {
    const resource = resourceEndAt(markdown, candidate.index + 1, remainingScan)
    scanned += resource.scanned
    remainingScan -= resource.scanned
    if (resource.end === undefined) {
      parseEnd = markdown.length
      break
    }
    parseEnd = Math.max(parseEnd, resource.end)
  }
  return { end: parseEnd, scanned }
}

function resourceEndAt(
  markdown: string,
  openingParenthesis: number,
  maximumScan: number,
): { end?: number; scanned: number } {
  let depth = 0
  let quote: string | undefined
  let angle = false
  const scanEnd = Math.min(markdown.length, openingParenthesis + maximumScan)
  for (let index = openingParenthesis; index < scanEnd; index += 1) {
    const character = markdown[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (angle) {
      if (character === '>') angle = false
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '<') angle = true
    else if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')' && --depth === 0) {
      return { end: index + 1, scanned: index + 1 - openingParenthesis }
    }
  }
  return { scanned: scanEnd - openingParenthesis }
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
  if (projectPath.startsWith('~/')) return homeRelativePosixReference(candidate, projectPath)
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

function homeRelativePosixReference(candidate: string, projectPath: string): ProjectFileReference {
  if (!candidate.startsWith('/')) {
    return { kind: 'blocked', path: candidate, reason: 'This file link is not absolute' }
  }

  const path = normalizePosix(candidate)
  const suffix = normalizePosix(projectPath.slice(1))
  const nestedBoundary = `${suffix}/`
  const suffixIndex = path === suffix ? 0 : path.indexOf(nestedBoundary)
  if (suffixIndex < 0) {
    return { kind: 'blocked', path: candidate, reason: 'This file is outside the selected project' }
  }

  const root = path.slice(0, suffixIndex + suffix.length)
  return posixReference(path, root)
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
