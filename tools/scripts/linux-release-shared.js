// Shared helpers for the Linux updater-metadata gate
// (tools/scripts/linux-updater-metadata.js) and the release-evidence script
// (tools/scripts/linux-release-evidence.js). Both scripts import from here;
// this module imports no sibling scripts, which breaks the former import cycle.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const UPDATER_YAML_MAX_BYTES = 65_536

export function fail(tag, message) {
  return new Error(`${tag} ${message}`)
}

export function compareAscii(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const SAFE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/

export function assertSafeName(fileName, context, tag) {
  if (
    typeof fileName !== 'string' ||
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName !== path.basename(fileName) ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    !SAFE_NAME_PATTERN.test(fileName)
  ) {
    throw fail(tag, `unsafe file name ${JSON.stringify(fileName)} (${context})`)
  }
}

const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

// electron-builder channel: stable updates via latest-linux.yml, a prerelease
// via <first-prerelease-identifier>-linux.yml (0.1.0-beta.1 -> beta-linux.yml).
export function channelForVersion(version, tag) {
  const match = typeof version === 'string' ? SEMVER_PATTERN.exec(version) : null
  if (!match) {
    throw fail(tag, `invalid semver version: ${JSON.stringify(version)}`)
  }
  return match[4] === undefined ? 'latest' : match[4].split('.')[0]
}

export function channelFileNameForVersion(version, tag) {
  return `${channelForVersion(version, tag)}-linux.yml`
}

// x64 `<channel>-linux.yml` plus arch-specific leftovers.
export function isChannelSidecar(fileName) {
  return /-linux(-arm64|-arm)?\.yml$/.test(fileName)
}

export function extraUpdaterSidecars(actualNames, allowed) {
  const keep = new Set(allowed)
  return actualNames
    .filter((name) => !keep.has(name))
    .filter((name) => name.endsWith('.blockmap') || name.endsWith('.zip') || isChannelSidecar(name))
    .sort(compareAscii)
}

// builder-util getArtifactArchName: AppImage uses x86_64, deb uses amd64.
function archName(extension, tag) {
  if (extension === 'AppImage') return 'x86_64'
  if (extension === 'deb') return 'amd64'
  throw fail(tag, `unsupported Linux target extension: ${extension}`)
}

function expandArtifactName(template, values, tag) {
  return template.replaceAll(/\$\{([^}]+)\}/g, (match, token) => {
    if (Object.hasOwn(values, token)) return values[token]
    throw fail(tag, `unsupported artifactName macro \${${token}} in ${template}`)
  })
}

// Expand the desktop artifactName template the same way electron-builder does
// for the two required x64 Linux targets.
export function expectedLinuxArtifactNames({ version, artifactName, productName, name }, tag) {
  if (!version || typeof version !== 'string') {
    throw fail(tag, 'a desktop package version is required')
  }
  const template = artifactName ?? 'TasteCode-${version}-${os}-${arch}.${ext}'
  const base = { version, os: 'linux', productName: productName ?? '', name: name ?? '' }
  return ['AppImage', 'deb']
    .map((extension) => {
      const fileName = expandArtifactName(
        template,
        { ...base, arch: archName(extension, tag), ext: extension },
        tag,
      )
      assertSafeName(fileName, `from template ${template}`, tag)
      return fileName
    })
    .sort(compareAscii)
}

async function digestFile(algorithm, encoding, filePath) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest(encoding)
}

export function sha256File(filePath) {
  return digestFile('sha256', 'hex', filePath)
}

export function sha512File(filePath) {
  return digestFile('sha512', 'base64', filePath)
}

export async function listReleaseFiles(releaseDirectory, tag, hint = '') {
  try {
    const entries = await readdir(releaseDirectory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(compareAscii)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw fail(tag, `release directory is missing: ${releaseDirectory}${hint}`)
    }
    throw error
  }
}

export async function readDesktopPackage(root, tag) {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'))
    if (pkg && typeof pkg.version === 'string' && pkg.version !== '') return pkg
  } catch {}
  throw fail(tag, 'apps/desktop/package.json has no version')
}

export function parseDirArgs(argv, { usage, tag, defaultDir }) {
  const options = { dir: defaultDir }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dir') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        throw fail(tag, `--dir requires a non-empty path (${usage})`)
      }
      index += 1
      options.dir = path.resolve(value)
    } else if (argument.startsWith('--dir=')) {
      const value = argument.slice('--dir='.length)
      if (value === '') {
        throw fail(tag, `--dir requires a non-empty path (${usage})`)
      }
      options.dir = path.resolve(value)
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw fail(tag, `unknown argument: ${argument} (${usage})`)
    }
  }
  return options
}
