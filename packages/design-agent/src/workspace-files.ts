import { lstatSync, opendirSync, realpathSync } from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 25_000
const MAX_DEPTH = 40
const OPAQUE_DIRECTORIES = new Set(['node_modules', '.pnpm-store'])

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
          throw new Error(`Design workspace scan exceeds ${MAX_ENTRIES} entries`)
        if (!prefix && (entry.name === '.git' || entry.name === '.taste')) continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (!entry.isDirectory()) {
          entries.push({ relative, file: entry.isFile() })
        } else if (OPAQUE_DIRECTORIES.has(entry.name) || ignoredDirectories.has(entry.name)) {
          entries.push({ relative: `${relative}/`, file: false })
        } else {
          entries.push({ relative: `${relative}/`, file: false })
          if (depth >= MAX_DEPTH)
            throw new Error(`Design workspace scan exceeds ${MAX_DEPTH} directory levels`)
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
