// Shared naming, hashing, and CLI helpers for Linux release preparation.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

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

export async function listReleaseFiles(releaseDirectory, tag, hint = '') {
  try {
    const entries = await readdir(releaseDirectory, { withFileTypes: true })
    const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name)
    if (nonFiles.length > 0) {
      throw fail(
        tag,
        `release directory must contain regular files only; rejected: ${nonFiles.sort(compareAscii).join(', ')}`,
      )
    }
    return entries.map((entry) => entry.name).sort(compareAscii)
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
  // pnpm forwards a bare `--` separator verbatim (`pnpm <script> -- --dir <d>`
  // reaches the script as `['--', '--dir', '<d>']`). Accept exactly one
  // optional leading separator; any other bare `--` stays fail-closed below.
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const options = { dir: defaultDir }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--dir') {
      const value = args[index + 1]
      if (value === undefined || value === '' || value === '--') {
        throw fail(tag, `--dir requires a non-empty path (${usage})`)
      }
      index += 1
      options.dir = path.resolve(value)
    } else if (argument.startsWith('--dir=')) {
      const value = argument.slice('--dir='.length)
      if (value === '' || value === '--') {
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
