import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { takeSnapshot } from './checkpoint.js'
import { listWorkspaceBranches } from './workspace.js'

const run = promisify(execFile)

/** Larger uncommitted changes stay where they are; the new chat is told where. */
const MAX_CARRIED_PATCH_BYTES = 64 * 1024 * 1024

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
  /**
   * The selected project folder inside the checkout. Differs from `path` when
   * the project is a subfolder of its repository.
   */
  workPath?: string
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
  baseRef?: string,
): Promise<Worktree> {
  if (!(await isRepository(repoPath))) throw new NotARepository(repoPath)
  if (baseRef !== undefined && !(await listWorkspaceBranches(repoPath)).includes(baseRef)) {
    throw new Error(`unknown local branch: ${baseRef}`)
  }

  const branch = `harness/${short(threadId)}`
  const target = path.join(root, short(threadId))

  // Stale metadata from a previous crash makes `worktree add` fail on a path
  // git still believes is registered. Pruning first is safe: it only forgets
  // worktrees whose directory is already gone.
  await git(repoPath, ['worktree', 'prune'])

  const result = await gitOrThrow(repoPath, [
    'worktree',
    'add',
    '-b',
    branch,
    target,
    baseRef === undefined ? 'HEAD' : `refs/heads/${baseRef}`,
  ])
  if (result instanceof Error) throw result

  // A project opened at a repository subfolder keeps that scope in its
  // checkout. A folder the commit does not contain falls back to the root.
  const prefix = (await git(repoPath, ['rev-parse', '--show-prefix'])) ?? ''
  const nested = prefix ? path.join(target, ...prefix.split('/').filter(Boolean)) : target
  const workPath = existsSync(nested) ? nested : target
  return { path: target, branch, repoPath, workPath }
}

export type CarriedChanges = { carried: true } | { carried: false; reason: string }

/**
 * Copy the uncommitted changes of one checkout into a private checkout that
 * was just created: tracked edits whether staged or not, deleted files, and
 * untracked files outside the ignore rules, binary ones included. Undefined
 * when there is nothing to carry, which includes a checkout that is gone.
 *
 * `from` is only read, so its changes also stay where they are. They go over
 * as one patch that git applies whole or not at all, so a refusal leaves `to`
 * as it was created.
 */
export async function carryUncommittedChanges(
  from: string,
  to: Worktree,
  maxPatchBytes = MAX_CARRIED_PATCH_BYTES,
): Promise<CarriedChanges | undefined> {
  if (!existsSync(from)) return undefined
  try {
    // A checkpoint snapshot records exactly this, on a temporary index: the
    // working tree with its untracked files, as a commit whose parent is HEAD.
    const snapshot = await takeSnapshot(from)
    if (snapshot.clean) return undefined
    const { stdout: patch } = await run(
      'git',
      [
        'diff',
        '--binary',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        `${snapshot.commit}^`,
        snapshot.commit,
      ],
      // Bytes, not text: a file in another encoding must arrive unchanged.
      {
        cwd: from,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: maxPatchBytes,
        encoding: 'buffer',
      },
    )
    if (patch.length === 0) return undefined
    await new Promise<void>((resolve, reject) => {
      // Plain apply: the working tree only, so nothing is staged in the new checkout.
      const child = execFile(
        'git',
        ['apply', '--binary', '--whitespace=nowarn', '-'],
        { cwd: to.path, windowsHide: true, timeout: 60_000 },
        (error) => (error ? reject(error) : resolve()),
      )
      child.stdin?.on('error', reject)
      child.stdin?.end(patch)
    })
    return { carried: true }
  } catch (error) {
    return { carried: false, reason: carryFailure(error, maxPatchBytes) }
  }
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
  //
  // Only that case. `git worktree remove` refuses for a second, far more
  // common reason: the checkout still holds modified or untracked files. This
  // used to delete the tree for ANY failure, so a user who answered "no, keep
  // my work" to the discard prompt could lose it anyway — the exact opposite
  // of what this file promises.
  if (removed instanceof Error) {
    if (existsSync(worktree.path)) throw removed
    await git(worktree.repoPath, ['worktree', 'prune'])
  }

  // The branch outlives the worktree on purpose. It holds the commits the
  // agent made, and deleting it would throw away the work along with the
  // scaffolding.
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  // A checkout that is not there holds nothing to lose. Asking git about a
  // missing cwd fails, and without this the user would be warned about losing
  // work in a directory that no longer exists.
  if (!existsSync(worktreePath)) return false
  const status = await git(worktreePath, ['status', '--porcelain'])
  // `git` swallows every other failure into undefined — a timeout, a missing
  // git, a corrupt index. Reading that as "clean" would green-light a
  // destructive removal on no evidence, so unknown counts as dirty.
  if (status === undefined) return true
  return status !== ''
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
    const parsed = z.object({ stderr: z.string().optional() }).safeParse(error)
    const stderr = parsed.success ? parsed.data.stderr : undefined
    return new Error(stderr?.trim() || (error instanceof Error ? error.message : String(error)))
  }
}

/** Why changes could not be carried, for the log: git's own words where it gave any. */
function carryFailure(error: unknown, maxPatchBytes: number): string {
  const parsed = z
    .object({ code: z.unknown().optional(), stderr: z.unknown().optional() })
    .safeParse(error)
  if (parsed.success && parsed.data.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    const megabytes = maxPatchBytes / 1024 / 1024
    return `the changes are larger than ${megabytes >= 1 ? `${Math.round(megabytes)} MB` : `${maxPatchBytes} bytes`}`
  }
  const stderr = parsed.success ? parsed.data.stderr : undefined
  const said = typeof stderr === 'string' || Buffer.isBuffer(stderr) ? String(stderr).trim() : ''
  return said || (error instanceof Error ? error.message : String(error))
}
