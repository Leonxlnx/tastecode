import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertPublicWorkspaceFile, isSecretWorkspaceName } from './api-workspace-paths.js'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const BINARY_SAMPLE_BYTES = 8 * 1024

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

  const children = await readdir(directory, { withFileTypes: true })
  const entries = (
    await Promise.all(
      children.map(async (entry): Promise<WorkspaceFileEntry | undefined> => {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return undefined
        const absolute = path.join(directory, entry.name)
        try {
          const metadata = await stat(absolute)
          const relative = toProtocolPath(path.relative(workspace, absolute))
          return {
            name: entry.name,
            path: relative,
            kind: entry.isDirectory() ? 'directory' : 'file',
            size: metadata.size,
            modifiedAt: metadata.mtimeMs,
            restricted: relative.split('/').some(isSecretWorkspaceName),
          }
        } catch {
          // A watcher, build or package manager may replace entries while the
          // directory is being read. One disappearing child is not a failed tree.
          return undefined
        }
      }),
    )
  )
    .filter((entry): entry is WorkspaceFileEntry => entry !== undefined)
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true })
    })

  return { path: toProtocolPath(path.relative(workspace, directory)), entries }
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
    ...(binary ? {} : { content: bytes.toString('utf8') }),
  }
}

async function containedRealPath(workspace: string, relativePath: string): Promise<string> {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
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
