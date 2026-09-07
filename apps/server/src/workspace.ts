import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)

export type WorkspaceInfo = {
  branch?: string
  added: number
  removed: number
  dirtyFiles: number
}

const EMPTY: WorkspaceInfo = { added: 0, removed: 0, dirtyFiles: 0 }

/**
 * Branch and uncommitted-change size for the composer shelf.
 *
 * Knowing which branch an agent is about to edit, and how much is already
 * uncommitted, is the difference between confidently sending a task and
 * checking a terminal first.
 *
 * Never throws: a folder that is not a repo is a normal case, not an error.
 */
export async function readWorkspace(path: string): Promise<WorkspaceInfo> {
  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === undefined) return EMPTY

  const stat = await git(path, ['diff', '--numstat', 'HEAD'])
  if (stat === undefined) return { branch, ...EMPTY }

  let added = 0
  let removed = 0
  let dirtyFiles = 0
  for (const line of stat.split('\n')) {
    if (line.trim() === '') continue
    const [a, r] = line.split('\t')
    // Binary files report "-", which is not a number and not a failure.
    added += Number(a) || 0
    removed += Number(r) || 0
    dirtyFiles += 1
  }

  return { branch, added, removed, dirtyFiles }
}

/** Local branches available to start work from, with the checked-out branch first. */
export async function listWorkspaceBranches(path: string): Promise<string[]> {
  const current = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const output = await git(path, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=refname',
    'refs/heads',
  ])
  if (output === undefined) return []

  const branches = output.split('\n').filter(Boolean)
  return current && branches.includes(current)
    ? [current, ...branches.filter((branch) => branch !== current)]
    : branches
}

/** Switch the project checkout without allowing an arbitrary git revision. */
export async function switchWorkspaceBranch(path: string, branch: string): Promise<WorkspaceInfo> {
  const branches = await listWorkspaceBranches(path)
  if (!branches.includes(branch)) throw new Error(`unknown local branch: ${branch}`)

  try {
    await run('git', ['switch', '--quiet', branch], {
      cwd: path,
      windowsHide: true,
      timeout: 10_000,
    })
  } catch (error) {
    const parsed = z.object({ stderr: z.string() }).safeParse(error)
    const stderr = parsed.success ? parsed.data.stderr.trim() : ''
    throw new Error(stderr || `could not switch to ${branch}`)
  }

  return readWorkspace(path)
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      windowsHide: true,
      timeout: 8000,
      // A large repo's numstat overflowing Node's 1 MiB default silently
      // reported the tree as clean right before dispatching an agent.
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return undefined
  }
}
