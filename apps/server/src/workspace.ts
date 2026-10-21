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
  const branch = await currentBranch(path)
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
  const current = await currentBranch(path)
  // `%(refname:short)` turns a branch that shares its name with a tag into
  // `heads/<name>`, which neither `git switch` nor `refs/heads/<name>` accepts.
  const output = await git(path, [
    'for-each-ref',
    '--format=%(refname)',
    '--sort=refname',
    'refs/heads',
  ])
  if (output === undefined) return []

  const branches = output
    .split('\n')
    .filter((ref) => ref.startsWith(HEADS))
    .map((ref) => ref.slice(HEADS.length))
  return current && branches.includes(current)
    ? [current, ...branches.filter((branch) => branch !== current)]
    : branches
}

/** Switch the project checkout without allowing an arbitrary git revision. */
export async function switchWorkspaceBranch(path: string, branch: string): Promise<WorkspaceInfo> {
  const branches = await listWorkspaceBranches(path)
  if (!branches.includes(branch)) throw new Error(`unknown local branch: ${branch}`)

  try {
    await run('git', ['switch', '--quiet', '--end-of-options', branch], {
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

const HEADS = 'refs/heads/'

/**
 * The checked-out branch's exact name, or `HEAD` when detached.
 *
 * `rev-parse --abbrev-ref` disambiguates against tags the same way
 * `%(refname:short)` does, so the full symbolic ref is read instead.
 */
export async function currentBranch(path: string): Promise<string | undefined> {
  const abbreviated = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (abbreviated === undefined || abbreviated === 'HEAD') return abbreviated
  const ref = await git(path, ['symbolic-ref', '-q', 'HEAD'])
  return ref?.startsWith(HEADS) ? ref.slice(HEADS.length) : abbreviated
}

/** What git reports for a checkout: its branch and changed paths, at most `limit` of them. */
export type WorkspaceChanges = { branch?: string; changes: string[]; more: number }

/**
 * The branch and `git status` of a checkout, each change as its two status
 * letters and path ("M src/a.ts", "?? notes.md", "R new.ts <- old.ts").
 * The branch is left out when HEAD is detached. Undefined when the folder is
 * no repository or git does not answer.
 */
export async function workspaceChanges(
  path: string,
  limit = 60,
): Promise<WorkspaceChanges | undefined> {
  let status: string
  try {
    // One process reports the branch and the changes. Without optional locks
    // a status never holds index.lock, which would fail a commit that another
    // chat in the same checkout makes at that moment.
    // Not trimmed: the first entry's status can begin with a space.
    ;({ stdout: status } = await run(
      'git',
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '--branch',
        '-z',
        '--untracked-files=normal',
      ],
      { cwd: path, windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
    ))
  } catch {
    return undefined
  }
  const records = status.split('\0')
  // Porcelain output is never translated, so its branch line can be read.
  const branch = records[0]?.startsWith('## ') ? statusBranch(records.shift()!.slice(3)) : undefined
  const changes: string[] = []
  let count = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    let entry = `${code.trim()} ${record.slice(3)}`
    // A rename or copy names its source in the next record.
    if (code[0] === 'R' || code[0] === 'C') {
      index += 1
      if (records[index]) entry += ` <- ${records[index]}`
    }
    count += 1
    if (changes.length < limit) changes.push(entry)
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    changes,
    more: count - changes.length,
  }
}

/**
 * The branch in a status branch line: "main", "main...origin/main [ahead 1]",
 * "No commits yet on main", or "HEAD (no branch)" when detached. A branch name
 * holds neither a space nor "..".
 */
function statusBranch(line: string): string | undefined {
  if (line.startsWith('HEAD (no branch)')) return undefined
  const name = line.replace(/^(?:No commits yet|Initial commit) on /, '')
  return name.split('...')[0]!.split(' ')[0] || undefined
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
