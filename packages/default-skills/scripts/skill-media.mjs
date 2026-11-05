// Reads the pinned GitHub archives of the default skills and decides which of
// their files TasteCode bundles. sync.js builds the bundle with these helpers.
import { createHash } from 'node:crypto'
import path from 'node:path'

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Pictures and the credits files beside them. Pages and scripts in the same folders still ship. */
const MEDIA_FILE = /\.(?:avif|gif|jpe?g|json|png|svg|webp)$/i

/** Files that only ever arrive by accident and have no business in a skill. */
const STRAY = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)__pycache__\//, /\.py[co]$/]

export function isStray(relative) {
  return STRAY.some((pattern) => pattern.test(relative))
}

/**
 * Reads a tar archive (ustar with pax or GNU long names, as GitHub writes them).
 * Yields regular files only; links and devices are refused, not followed.
 */
export function* tarEntries(archive) {
  let offset = 0
  let longName
  let paxPath
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => {
      const raw = header.subarray(start, start + length)
      const end = raw.indexOf(0)
      return raw.subarray(0, end === -1 ? length : end).toString('utf8')
    }
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('Corrupt tar header size')
    const type = field(156, 1) || '0'
    const prefix = field(257, 6).startsWith('ustar') ? field(345, 155) : ''
    const body = archive.subarray(offset + 512, offset + 512 + size)
    if (body.length !== size) throw new Error('Truncated tar archive')
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'g') continue
    if (type === 'x') {
      paxPath = paxRecords(body).path
      continue
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '')
      continue
    }
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    paxPath = undefined
    longName = undefined
    if (type === '5') continue
    if (type !== '0' && type !== '7') throw new Error(`Refusing tar entry of type ${type}: ${name}`)
    yield { name, body }
  }
}

function paxRecords(body) {
  const records = {}
  let at = 0
  const text = body.toString('utf8')
  while (at < text.length) {
    const space = text.indexOf(' ', at)
    if (space === -1) break
    const length = Number.parseInt(text.slice(at, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, at + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }
  return records
}

/**
 * The files of one skill inside its repository archive, relative to the skill
 * folder. GitHub prefixes every entry with `<repo>-<commit>/`.
 */
export function skillFiles(archive, skill) {
  const files = new Map()
  const base = skill.path ? `${skill.path.replace(/\/+$/, '')}/` : ''
  let license
  for (const entry of tarEntries(archive)) {
    const parts = entry.name.split('/')
    const inRepo = parts.slice(1).join('/')
    if (!inRepo) continue
    if (parts.some((part) => part === '..') || path.isAbsolute(inRepo))
      throw new Error(`Unsafe path in archive: ${entry.name}`)
    if (inRepo === skill.licenseFile) license = entry.body
    if (!inRepo.startsWith(base)) continue
    const relative = inRepo.slice(base.length)
    if (!relative || isStray(relative) || (skill.exclude ?? []).includes(relative)) continue
    files.set(relative, entry.body)
  }
  if (!files.has('SKILL.md')) throw new Error(`${skill.folder}: no SKILL.md under ${base || '/'}`)
  if (!license) throw new Error(`${skill.folder}: licence file ${skill.licenseFile} not found`)
  // Each shipped skill carries its own licence, whatever folder it came from.
  files.set('LICENSE', license)
  return files
}

/** Order-independent digest of a file set: relative path, size and content of each. */
export function digestFiles(files) {
  const hash = createHash('sha256')
  let bytes = 0
  const names = [...files.keys()].sort()
  for (const name of names) {
    const body = files.get(name)
    bytes += body.length
    hash.update(`${name}\0${body.length}\0`)
    hash.update(createHash('sha256').update(body).digest('hex'))
    hash.update('\n')
  }
  return { treeSha256: hash.digest('hex'), files: names.length, bytes }
}

export function archiveUrl(skill) {
  return `https://codeload.github.com/${skill.repository}/tar.gz/${skill.commit}`
}

export async function fetchArchive(skill, fetchImpl = fetch) {
  const url = archiveUrl(skill)
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`${skill.folder}: ${url} answered ${response.status}`)
  const gz = Buffer.from(await response.arrayBuffer())
  if (gz.length > MAX_ARCHIVE_BYTES) throw new Error(`${skill.folder}: archive is too large`)
  return gz
}

/**
 * Whether a skill file is left out of the bundle. A `paths` entry ending in `/`
 * takes the pictures and credits files under that folder; an entry with `*`
 * takes the files it matches, `*` staying inside one path segment; any other
 * entry names one file.
 */
export function isOmitted(relative, omit) {
  return omit.paths.some((entry) =>
    entry.endsWith('/')
      ? relative.startsWith(entry) && MEDIA_FILE.test(relative)
      : entry.includes('*')
        ? segmentPattern(entry).test(relative)
        : relative === entry,
  )
}

/** A path pattern whose `*` stands for any run of characters inside one path segment. */
function segmentPattern(entry) {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/** A skill's files without the ones its `omit` entry leaves out. */
export function omitFiles(files, omit) {
  return new Map([...files].filter(([name]) => !isOmitted(name, omit)))
}
