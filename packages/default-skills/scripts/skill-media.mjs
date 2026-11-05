// Reads the pinned GitHub archives of the default skills. sync.js builds the
// bundle with these helpers. The file has no imports beyond Node, so it can
// also ship inside a skill.
//
// A skill's third-party media (photographs, icons and their credits files) is
// not shipped in the installer. sync.js puts this file where the script that
// reads that media used to be (`media.loader` in skills.json). When run there,
// it fetches the media once from the skill's pinned commit, checks it against
// the measured hashes and keeps it in the user's data folder. Then it runs the
// original script from that copy:
//
//   node <skill>/scripts/photos.mjs <arguments>
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Pictures and the credits files beside them. Pages and scripts in the same folders still ship. */
const MEDIA_FILE = /\.(?:avif|gif|jpe?g|json|png|svg|webp)$/i
/** Written last into a finished copy, so a half-written one never counts as loaded. */
const MARKER = '.tastecode-media.json'

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
 * Whether a skill file belongs to the fetched media. A `paths` entry ending in
 * `/` takes the pictures and credits files under that folder; any other entry
 * names one file.
 */
export function isMediaFile(relative, media) {
  return media.paths.some((entry) =>
    entry.endsWith('/')
      ? relative.startsWith(entry) && MEDIA_FILE.test(relative)
      : relative === entry,
  )
}

/**
 * Splits a skill's files into what the installer ships and what is fetched on
 * first use: the media, plus the original script that the loader replaces.
 */
export function splitMedia(files, media) {
  const shipped = new Map()
  const fetched = new Map()
  for (const [name, body] of files)
    (name === media.loader || isMediaFile(name, media) ? fetched : shipped).set(name, body)
  return { shipped, fetched }
}

/** Where fetched media is kept: per user, outside the app's read-only resources. */
export function mediaCacheRoot(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const configured = env.TASTECODE_SKILL_MEDIA_DIR?.trim()
  if (configured) return path.resolve(configured)
  if (platform === 'win32')
    return path.join(
      env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      'TasteCode',
      'skill-media',
    )
  if (platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'TasteCode', 'skill-media')
  return path.join(
    env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
    'TasteCode',
    'skill-media',
  )
}

/** Media that could not be fetched or did not match its pin; the message is for the agent. */
export class MediaUnavailable extends Error {}

function markerText(media) {
  const { treeSha256, files, bytes } = media
  return `${JSON.stringify({ treeSha256, files, bytes })}\n`
}

async function isLoaded(dir, media) {
  try {
    return (await readFile(path.join(dir, MARKER), 'utf8')) === markerText(media)
  } catch {
    return false
  }
}

function reason(error) {
  const cause = error instanceof Error ? error.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  return code ? String(code) : error instanceof Error ? error.message : String(error)
}

/**
 * The folder that holds a skill's fetched media at its pinned commit. Fetches
 * it on the first call; later calls read the cached copy and need no network.
 */
export async function ensureMedia(
  skill,
  { cacheRoot = mediaCacheRoot(), fetchImpl = fetch, log = (line) => console.error(line) } = {},
) {
  const media = skill.media
  const dir = path.join(cacheRoot, skill.folder, skill.commit)
  if (await isLoaded(dir, media)) return dir
  const url = archiveUrl(skill)
  const fail = (what) =>
    new MediaUnavailable(
      `The ${skill.folder} media (photographs and icons, about ${Math.round(media.bytes / 1e6)} MB) ` +
        `is not on this computer yet: ${what}. It is downloaded once from ${url} and kept in ${dir}. ` +
        "Connect to the internet and run the command again. Pages built from the client's own photographs do not need it.",
    )
  log(`Downloading the ${skill.folder} media once from ${url} ...`)
  let gz
  try {
    gz = await fetchArchive(skill, fetchImpl)
  } catch (error) {
    throw fail(`the download failed (${reason(error)})`)
  }
  const archiveSha256 = createHash('sha256').update(gz).digest('hex')
  if (archiveSha256 !== skill.archiveSha256)
    throw fail(
      `the download's sha256 ${archiveSha256} does not match the pinned ${skill.archiveSha256}, so nothing was kept`,
    )
  const { fetched } = splitMedia(skillFiles(gunzipSync(gz), skill), media)
  const digest = digestFiles(fetched)
  if (digest.treeSha256 !== media.treeSha256)
    throw fail(
      `the downloaded files (${digest.files} files, ${digest.bytes} bytes) do not match the pinned ${media.files} files, ${media.bytes} bytes, so nothing was kept`,
    )
  const staging = `${dir}.staging-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    for (const [relative, body] of fetched) {
      const target = path.join(staging, ...relative.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, body)
    }
    await writeFile(path.join(staging, MARKER), markerText(media))
    if (!(await isLoaded(dir, media))) await rm(dir, { recursive: true, force: true })
    try {
      await rename(staging, dir)
    } catch (error) {
      // Another run finished the same copy first.
      if (!(await isLoaded(dir, media))) throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return dir
}

/** Run as `<bundle>/skills/<folder>/<media.loader>`: load the media, then hand over to the original. */
async function runLoader(file, argv) {
  const skillDir = path.resolve(path.dirname(file), '..')
  const folder = path.basename(skillDir)
  const manifest = JSON.parse(
    await readFile(path.join(skillDir, '..', '..', 'skills.json'), 'utf8'),
  )
  const skill = manifest.skills?.find((entry) => entry.folder === folder && entry.media)
  if (!skill) throw new MediaUnavailable(`skills.json lists no media for ${folder}`)
  const dir = await ensureMedia(skill)
  const original = path.join(dir, ...skill.media.loader.split('/'))
  const result = spawnSync(process.execPath, [original, ...argv], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

function realOf(file) {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && realOf(process.argv[1]) === realOf(self)) {
  runLoader(self, process.argv.slice(2)).catch((error) => {
    console.error(
      `${path.basename(self, '.mjs')}: ${error instanceof Error ? error.message : error}`,
    )
    process.exitCode = 1
  })
}
