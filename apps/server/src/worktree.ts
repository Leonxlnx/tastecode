import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import path from 'node:path'

const run = promisify(execFile)

/**
 * A private checkout per session.
 *
 * Two agents in one working directory overwrite each other's edits, and the
 * second one to write wins silently. A worktree gives each session its own
 * checkout of the same repository on its own branch, which is what makes
 * parallel work safe rather than merely concurrent.
 *
 * Everything here refuses rather than forces. An agent's work is the user's
 * work: losing it to a tidy-up is worse than leaving a directory behind.
 */

export type Worktree = {
  /** Absolute path to the private checkout. */
  path: string
  branch: string
  /** The repository it belongs to. */
  repoPath: string
}

export class NotARepository extends Error {
  constructor(repoPath: string) {
    super(`${repoPath} is not a git repository, so a session cannot be isolated in it`)
    this.name = 'NotARepository'
  }
}

export class WorktreeDirty extends Error {
  constructor(readonly worktreePath: string) {
    super(
      `${worktreePath} has uncommitted changes. Commit or discard them, ` +
        `then remove the session again.`,
    )
    this.name = 'WorktreeDirty'
  }
}

export async function isRepository(repoPath: string): Promise<boolean> {
  return (await git(repoPath, ['rev-parse', '--git-dir'])) !== undefined
}

/**
 * Create a worktree for a session.
 *
 * The branch is named after the session rather than the task, because at
 * creation time we have an id and not yet a topic — and a branch that silently
 * collides with an existing one would put two sessions on the same commits,
 * which is the thing this exists to prevent.
 */
export async function createWorktree(
  repoPath: string,
  threadId: string,
  root: string,
): Promise<Worktree> {
  if (!(await isRepository(repoPath))) throw new NotARepository(repoPath)

  const branch = `harness/${short(threadId)}`
  const target = path.join(root, short(threadId))

  // Stale metadata from a previous crash makes `worktree add` fail on a path
  // git still believes is registered. Pruning first is safe: it only forgets
  // worktrees whose directory is already gone.
  await git(repoPath, ['worktree', 'prune'])

  const result = await gitOrThrow(repoPath, ['worktree', 'add', '-b', branch, target, 'HEAD'])
  if (result instanceof Error) throw result

  return { path: target, branch, repoPath }
}

/**
 * Remove a worktree, refusing if the agent left work behind.
 *
 * `force` is the user answering "yes, discard it" — never a default, and never
 * something we decide for them.
 */
export async function removeWorktree(worktree: Worktree, force = false): Promise<void> {
  if (!force && (await hasUncommittedChanges(worktree.path))) {
    throw new WorktreeDirty(worktree.path)
  }

  const args = ['worktree', 'remove', worktree.path]
  if (force) args.push('--force')
  const removed = await gitOrThrow(worktree.repoPath, args)

  // The directory can already be gone — a manual delete, a cleaned temp dir.
  // git then refuses, but the outcome the caller wanted is already true.
  if (removed instanceof Error) {
    await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined)
    await git(worktree.repoPath, ['worktree', 'prune'])
  }

  // The branch outlives the worktree on purpose. It holds the commits the
  // agent made, and deleting it would throw away the work along with the
  // scaffolding.
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const status = await git(worktreePath, ['status', '--porcelain'])
  return status !== undefined && status !== ''
}

/**
 * Forget worktrees whose directories no longer exist.
 *
 * A crash leaves git believing in a checkout that is gone, and the next
 * session on that path fails to start with a message about a path that is
 * "already registered" — an error about our own leftovers, shown to someone
 * who did nothing wrong.
 */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, ['worktree', 'prune'])
}

function short(threadId: string): string {
  // Thread ids carry a provider prefix and a uuid. The tail is unique enough
  // for a directory and a branch, and short enough to read in `git branch`.
  const cleaned = threadId.replace(/[^a-zA-Z0-9-]/g, '-')
  return cleaned.slice(-12)
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 15000 })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** Like `git`, but returns the failure so a caller can report what went wrong. */
async function gitOrThrow(cwd: string, args: string[]): Promise<string | Error> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 30000 })
    return stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr
    return new Error(stderr?.trim() || (error instanceof Error ? error.message : String(error)))
  }
}
