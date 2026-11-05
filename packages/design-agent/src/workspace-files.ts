import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 25_000

/**
 * A workspace too large for a bounded scan. Checks built on a full scan treat it as "not run"
 * instead of failing a Design run on a big real project.
 */
export class DesignScanLimitError extends Error {}
const MAX_DEPTH = 40
/**
 * Dependency and cache trees no design reads or delivers into. Listed but never
 * entered: a single virtualenv or Rust `target` folder exceeds the entry cap.
 */
const OPAQUE_DIRECTORIES = new Set([
  'node_modules',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.gradle',
  // Package-manager caches a sandboxed agent may keep inside the workspace (#1553).
  '.bun-cache',
  '.npm',
  '.npm-cache',
  '.pnpm-cache',
  '.yarn',
  '.yarn-cache',
  'bower_components',
  'jspm_packages',
  '.parcel-cache',
  '.vite',
  '.angular',
  // Build output, framework and tool caches that real projects keep beside their sources.
  '.output',
  '.vercel',
  '.netlify',
  '.expo',
  '.docusaurus',
  '.astro',
  '.dart_tool',
  'Pods',
  'DerivedData',
  '.terraform',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
])
const MAX_GIT_POINTER_BYTES = 4096

/**
 * A `.git` file pointing into a repository's `worktrees/` folder marks a linked worktree: a
 * second checkout, usually of the same project. Tools that keep worktrees inside the project
 * (`.worktrees/`, `.claude/worktrees/`) multiply the tree by their count. Submodule pointers
 * lead into `modules/` and stay part of the scan.
 */
function linkedWorktree(directory: string): boolean {
  const marker = path.join(directory, '.git')
  let stat
  try {
    stat = lstatSync(marker)
  } catch {
    return false
  }
  if (!stat.isFile() || stat.size > MAX_GIT_POINTER_BYTES) return false
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(
    readWorkspaceFile(marker, MAX_GIT_POINTER_BYTES).toString('utf8'),
  )?.[1]
  const segments = pointer?.split(/[\\/]+/u).filter(Boolean) ?? []
  return segments.at(-2) === 'worktrees'
}

export interface WorkspaceEntry {
  relative: string
  file: boolean
}

export function normalizeWorkspaceFile(file: string): string | undefined {
  const portable = file.replaceAll('\\', '/')
  if (
    [...portable].some((character) => character.charCodeAt(0) < 32) ||
    /[<>:"|?*]/u.test(portable) ||
    portable.startsWith('/') ||
    portable.split('/').includes('..')
  )
    return undefined
  const normalized = path.posix.normalize(portable)
  return normalized === '.' || normalized.endsWith('/') ? undefined : normalized
}

/** Traverse real directories only, with explicit limits instead of silently skipping work. */
export function workspaceEntries(
  workspacePath: string,
  ignoredDirectories: ReadonlySet<string> = new Set(),
): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = []
  const pending = [{ absolute: realpathSync(workspacePath), prefix: '', depth: 0 }]
  let count = 0
  while (pending.length) {
    const { absolute, prefix, depth } = pending.pop()!
    if (!lstatSync(absolute).isDirectory())
      throw new Error('Design workspace directory changed during scanning')
    const directory = opendirSync(absolute)
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++count > MAX_ENTRIES)
          throw new DesignScanLimitError(`Design workspace scan exceeds ${MAX_ENTRIES} entries`)
        if (!prefix && (entry.name === '.git' || entry.name === '.taste')) continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (!entry.isDirectory()) {
          entries.push({ relative, file: entry.isFile() })
        } else if (OPAQUE_DIRECTORIES.has(entry.name) || ignoredDirectories.has(entry.name)) {
          entries.push({ relative: `${relative}/`, file: false })
        } else if (linkedWorktree(path.join(absolute, entry.name))) {
          // The marker stays listed, so a pointer written during a Build is still a new file.
          entries.push({ relative: `${relative}/`, file: false })
          entries.push({ relative: `${relative}/.git`, file: true })
        } else {
          entries.push({ relative: `${relative}/`, file: false })
          if (depth >= MAX_DEPTH)
            throw new DesignScanLimitError(
              `Design workspace scan exceeds ${MAX_DEPTH} directory levels`,
            )
          pending.push({
            absolute: path.join(absolute, entry.name),
            prefix: relative,
            depth: depth + 1,
          })
        }
      }
    } finally {
      directory.closeSync()
    }
  }
  return entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
}

export function containedWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  label: string,
  allowDirectory = false,
): string {
  const normalized = normalizeWorkspaceFile(relativePath)
  if (!normalized) throw new Error(`${label} must stay inside the workspace`)
  const root = realpathSync(workspacePath)
  let candidate: string
  try {
    candidate = realpathSync(path.join(root, normalized))
  } catch {
    throw new Error(`${label} does not exist`)
  }
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the workspace after resolving symlinks`)
  }
  const stat = lstatSync(candidate)
  if (!stat.isFile() && !(allowDirectory && stat.isDirectory()))
    throw new Error(`${label} must be a regular file`)
  return candidate
}

/** Bound allocation and read through one descriptor; a growing file cannot bypass the limit. */
export function readWorkspaceFile(filePath: string, maxBytes: number): Buffer {
  const before = lstatSync(filePath)
  if (!before.isFile())
    throw new Error(`Design file ${path.basename(filePath)} must be a regular file`)
  const fd = openSync(filePath, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw new Error(`Design file ${path.basename(filePath)} changed while opening`)
    }
    if (stat.size > maxBytes)
      throw new DesignScanLimitError(
        `Design file ${path.basename(filePath)} exceeds ${maxBytes} bytes`,
      )
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (!read) break
      length += read
    }
    if (length !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) {
      throw new Error(`Design file ${path.basename(filePath)} changed while reading`)
    }
    return bytes.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}
