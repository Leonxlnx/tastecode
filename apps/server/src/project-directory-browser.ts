import { readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type ProjectDirectoryEntry = {
  path: string
  name: string
  kind: 'directory' | 'file'
  modifiedAt: number
}

export type ProjectDirectoryListing = {
  path: string
  name: string
  parent?: string
  entries: ProjectDirectoryEntry[]
}

/**
 * Lists one folder for the paired mobile project picker.
 *
 * The picker starts at the server user's home directory and cannot walk above
 * it. Hidden entries and symbolic links stay out of the remote surface: they
 * add noise in a project picker, and a symlink could otherwise escape the
 * home-directory boundary after the path check.
 */
export async function browseProjectDirectory(
  requestedPath?: string,
  homeDirectory = os.homedir(),
): Promise<ProjectDirectoryListing> {
  const root = await canonicalDirectory(homeDirectory, 'The home folder is not available.')
  const current = await canonicalDirectory(
    requestedPath ?? root,
    'That folder is no longer available.',
  )

  if (!isWithin(root, current)) {
    throw new Error('The mobile project picker can only browse inside your home folder.')
  }

  const children = await readdir(current, { withFileTypes: true })
  const entries = (
    await Promise.all(
      children
        .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
        .map(async (entry): Promise<ProjectDirectoryEntry | undefined> => {
          const childPath = path.join(current, entry.name)
          try {
            const metadata = await stat(childPath)
            return {
              path: childPath,
              name: entry.name,
              kind: entry.isDirectory() ? 'directory' : 'file',
              modifiedAt: metadata.mtimeMs,
            }
          } catch {
            // Directory contents can change while they are being listed. A
            // vanished entry should not make the whole picker unusable.
            return undefined
          }
        }),
    )
  )
    .filter((entry): entry is ProjectDirectoryEntry => entry !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))

  const relative = path.relative(root, current)
  return {
    path: current,
    name: path.basename(current),
    ...(relative ? { parent: path.dirname(current) } : {}),
    entries,
  }
}

async function canonicalDirectory(location: string, unavailableMessage: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(location)
  } catch {
    throw new Error(unavailableMessage)
  }

  try {
    if (!(await stat(canonical)).isDirectory()) throw new Error(unavailableMessage)
  } catch {
    throw new Error(unavailableMessage)
  }
  return canonical
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}
