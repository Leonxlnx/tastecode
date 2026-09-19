// electron-builder afterPack hook for Linux: the deb must be lintian-clean, and
// Debian norms are 0644 data files, 0755 directories and executables. A source
// checkout inherits the build machine's umask (002 produces 0664/0775 payloads)
// and Electron ships its shared libraries executable, so the staged tree is
// normalized here instead of relying on local umask discipline. The hook runs
// inside electron-builder, so the fix applies to local dist:linux and CI alike.
import { execFileSync } from 'node:child_process'
import { chmod, lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

const TAG = '[normalize-linux-perms]'

// Shared libraries and native addons are loaded, never exec'd: lintian's
// shared-library-is-executable and odd-permissions-on-shared-library both
// require 0644. The executable bit alone would leave Electron's 0755 *.so
// files flagged.
const SHARED_OBJECT = /\.(?:node|so(?:\.\d+)*)$/

// The only shipped ELF objects that may be stripped: both are build products
// flagged unstripped-binary-or-object. Upstream Electron binaries and
// libraries keep their original bytes — they are not ours to modify.
const STRIP_BINARIES = new Set(['pty.node', 'libvulkan.so.1'])

export function payloadFileMode(name, mode) {
  if (SHARED_OBJECT.test(name)) return 0o644
  if ((mode & 0o111) !== 0) return 0o755 | (mode & 0o7000)
  return 0o644
}

async function normalizeEntry(entry, kind) {
  const { mode } = await lstat(entry)
  const desired =
    kind === 'directory' ? 0o755 | (mode & 0o7000) : payloadFileMode(path.basename(entry), mode)
  if ((mode & 0o7777) !== desired) {
    await chmod(entry, desired)
    return true
  }
  return false
}

// Walk the staged app directory once: normalize every entry and collect the
// binaries approved for stripping. Symlinks keep their own mode — the payload
// ships none today, but a link must never be chmod'd through its target.
export async function normalizePayloadTree(root) {
  const normalized = { directories: 0, files: 0, strippable: [] }
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (await normalizeEntry(full, 'directory')) normalized.directories += 1
        await walk(full)
      } else if (entry.isFile()) {
        if (await normalizeEntry(full, 'file')) normalized.files += 1
        if (STRIP_BINARIES.has(entry.name)) normalized.strippable.push(full)
      }
    }
  }
  if (await normalizeEntry(root, 'directory')) normalized.directories += 1
  await walk(root)
  return normalized
}

// strip --strip-unneeded removes the symbol and debug data lintian flags as
// unstripped-binary-or-object. Missing binutils is a broken build environment,
// not a skippable step — a silent skip would ship the lintian error.
export async function stripPayloadBinaries(binaries, run = execFileSync) {
  if (binaries.length === 0) return
  try {
    run('strip', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error(`${TAG} strip is required on PATH to strip ${binaries.join(', ')}`)
  }
  for (const binary of binaries) run('strip', ['--strip-unneeded', binary], { stdio: 'inherit' })
}

// Icons, metainfo and copyright reach the deb through fpm's src=dest mappings,
// which clone the source file's mode — the payload walk cannot see them. Asset
// sources are pure data, always 0644; git only tracks the exec bit, so the
// checkout stays clean for the provenance gate.
export async function normalizeAssetSources(assetsDirectory) {
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const { mode } = await lstat(full)
        if ((mode & 0o7777) !== 0o644) await chmod(full, 0o644)
      }
    }
  }
  await walk(assetsDirectory)
}

export async function afterPack(context) {
  if (context?.electronPlatformName !== 'linux') return
  // Everything electron-builder stages after this hook (the .desktop entry,
  // app-update.yml, package-type, mime data) takes the process umask — pin it
  // to the Debian-normal 022 so staged files are not group-writable.
  process.umask(0o022)
  const { appOutDir, packager } = context
  const { directories, files, strippable } = await normalizePayloadTree(appOutDir)
  await stripPayloadBinaries(strippable)
  await normalizeAssetSources(path.join(packager.projectDir, 'assets'))
  process.stdout.write(
    `${TAG} normalized ${files} files and ${directories} directories, ` +
      `stripped ${strippable.length} binaries in ${appOutDir}\n`,
  )
}

export default afterPack
