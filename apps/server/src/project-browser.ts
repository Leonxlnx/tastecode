import { existsSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ProjectBrowseResult } from '@harness/contracts'

const MAX_FOLDERS = 500

type BrowseOptions = {
  home?: string
  /** Paths already registered as projects. */
  projects?: ReadonlySet<string>
  platform?: NodeJS.Platform
}

/**
 * One folder's subfolders, for choosing a project on a client without a
 * native folder picker. Browsing stays inside the home folder, the other
 * drives on Windows and mounted volumes on macOS. Hidden folders, files and
 * symbolic links are left out: they are noise in a project picker, and a link
 * could lead outside those places after the path check.
 */
export async function browseFolders(
  requestedPath: string | undefined,
  options: BrowseOptions = {},
): Promise<ProjectBrowseResult> {
  const platform = options.platform ?? process.platform
  const home = await canonicalFolder(
    options.home ?? os.homedir(),
    'The home folder is not available',
  )
  const roots = [{ name: 'Home', path: home }, ...(await extraRoots(platform))]
  const current = await canonicalFolder(requestedPath ?? home, 'That folder is no longer available')
  const root = roots
    .filter((candidate) => isWithin(candidate.path, current))
    .sort((left, right) => right.path.length - left.path.length)[0]
  if (!root) throw new Error('Projects can be chosen from your home folder or another drive')

  const children = await readdir(current, { withFileTypes: true }).catch(() => {
    throw new Error('TasteCode cannot read that folder')
  })
  const visible = children
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }),
    )
  const folders = visible.slice(0, MAX_FOLDERS).map((entry) => {
    const folder = path.join(current, entry.name)
    return {
      name: entry.name,
      path: folder,
      repository: existsSync(path.join(folder, '.git')),
      added: options.projects?.has(folder) ?? false,
    }
  })
  const parent = path.dirname(current)
  return {
    path: current,
    ...(current !== root.path && parent !== current ? { parent } : {}),
    home,
    roots,
    folders,
    truncated: visible.length > folders.length,
  }
}

async function extraRoots(
  platform: NodeJS.Platform,
): Promise<Array<{ name: string; path: string }>> {
  if (platform === 'win32') {
    const drives: Array<{ name: string; path: string }> = []
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`
      if (existsSync(drive)) drives.push({ name: `${letter}:`, path: drive })
    }
    return drives
  }
  if (platform === 'darwin') {
    const volumes = await readdir('/Volumes', { withFileTypes: true }).catch(() => [])
    // The startup disk appears here as a link to `/`; only real mounts are listed.
    return volumes
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: path.join('/Volumes', entry.name) }))
  }
  return []
}

async function canonicalFolder(location: string, unavailable: string): Promise<string> {
  try {
    const canonical = await realpath(location)
    if ((await stat(canonical)).isDirectory()) return canonical
  } catch {
    // Reported below in the caller's words.
  }
  throw new Error(unavailable)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}
