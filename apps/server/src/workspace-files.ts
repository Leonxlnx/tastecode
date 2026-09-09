import { stat as callbackStat, type Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertPublicWorkspaceFile, isSecretWorkspaceName } from './api-workspace-paths.js'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const BINARY_SAMPLE_BYTES = 8 * 1024
const WORKSPACE_ENTRY_COLLATOR = new Intl.Collator(undefined, { numeric: true })

export type WorkspaceFileEntry = {
  name: string
  path: string
  kind: 'directory' | 'file'
  size: number
  modifiedAt: number
  restricted: boolean
}

export type WorkspaceFileContents = {
  name: string
  path: string
  size: number
  binary: boolean
  truncated: boolean
  content?: string
}

/**
 * Lists one directory in a registered workspace. Directories are loaded on
 * demand so opening Files never walks node_modules or a monorepo eagerly.
 */
export async function listWorkspaceDirectory(
  workspacePath: string,
  relativeDirectory = '',
): Promise<{ path: string; entries: WorkspaceFileEntry[] }> {
  const workspace = await realpath(workspacePath)
  const directory = await containedRealPath(workspace, relativeDirectory)
  if (!(await stat(directory)).isDirectory()) throw new Error('path must be a directory')

  const protocolDirectory = toProtocolPath(path.relative(workspace, directory))
  const children = await readdir(directory, { withFileTypes: true })
  const entries = await workspaceEntries(protocolDirectory, directory, children)

  return { path: protocolDirectory, entries }
}

/** Queue every stat for maximum file-system throughput without one promise per child. */
function workspaceEntries(
  protocolDirectory: string,
  directory: string,
  children: Dirent[],
): Promise<WorkspaceFileEntry[]> {
  return new Promise((resolve) => {
    const entries: Array<WorkspaceFileEntry | undefined> = []
    entries.length = children.length
    const absoluteDirectory = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`
    const directoryRestricted = protocolDirectory.split('/').some(isSecretWorkspaceName)
    let entryCount = 0
    let pending = 0
    let queued = true
    const finish = () => {
      if (queued || pending > 0) return
      const completeEntries =
        entryCount === entries.length
          ? (entries as WorkspaceFileEntry[])
          : entries.filter((entry): entry is WorkspaceFileEntry => entry !== undefined)
      resolve(completeEntries.sort(compareWorkspaceEntries))
    }

    for (let index = 0; index < children.length; index += 1) {
      const entry = children[index]!
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
      const absolute = `${absoluteDirectory}${entry.name}`
      const relative = protocolDirectory ? `${protocolDirectory}/${entry.name}` : entry.name
      const kind = entry.isDirectory() ? 'directory' : 'file'
      const restricted = directoryRestricted || isSecretWorkspaceName(entry.name)
      pending += 1
      try {
        callbackStat(absolute, (error, metadata) => {
          pending -= 1
          if (!error) {
            entries[index] = {
              name: entry.name,
              path: relative,
              kind,
              size: metadata.size,
              modifiedAt: metadata.mtimeMs,
              restricted,
            }
            entryCount += 1
          }
          finish()
        })
      } catch {
        pending -= 1
      }
    }
    queued = false
    finish()
  })
}

export function compareWorkspaceEntries(
  left: WorkspaceFileEntry,
  right: WorkspaceFileEntry,
): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return WORKSPACE_ENTRY_COLLATOR.compare(left.name, right.name)
}

/** Reads at most two MiB of one public UTF-8 workspace file. */
export async function readWorkspaceTextFile(
  workspacePath: string,
  relativeFile: string,
): Promise<WorkspaceFileContents> {
  const workspace = await realpath(workspacePath)
  const file = await containedRealPath(workspace, relativeFile)
  assertPublicWorkspaceFile(file)
  const metadata = await stat(file)
  if (!metadata.isFile()) throw new Error('path must be a file')

  const bytesToRead = Math.min(metadata.size, MAX_TEXT_BYTES)
  const buffer = Buffer.alloc(bytesToRead)
  const handle = await open(file, 'r')
  let bytesRead = 0
  try {
    ;({ bytesRead } = await handle.read(buffer, 0, bytesToRead, 0))
  } finally {
    await handle.close()
  }

  const bytes = buffer.subarray(0, bytesRead)
  const binary = bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)
  return {
    name: path.basename(file),
    path: toProtocolPath(path.relative(workspace, file)),
    size: metadata.size,
    binary,
    truncated: metadata.size > bytesRead,
    ...(!binary ? { content: bytes.toString('utf8') } : {}),
  }
}

async function containedRealPath(workspace: string, relativePath: string): Promise<string> {
  if (relativePath.includes('\0')) {
    throw new Error('workspace path must be a string')
  }
  if (path.isAbsolute(relativePath)) throw new Error('workspace path must be relative')

  const candidate = path.resolve(workspace, relativePath || '.')
  assertContained(workspace, candidate)
  const canonical = await realpath(candidate)
  assertContained(workspace, canonical)
  return canonical
}

function assertContained(workspace: string, candidate: string): void {
  const relative = path.relative(workspace, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path escapes the workspace')
  }
}

function toProtocolPath(value: string): string {
  return value.split(path.sep).join('/')
}
