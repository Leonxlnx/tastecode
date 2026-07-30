import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * A point a session can be returned to.
 *
 * An agent that has gone the wrong way for five turns leaves the user undoing
 * it by hand. A checkpoint is a snapshot of the working tree taken before the
 * agent writes, plus the point in the conversation it belongs to, so going back
 * puts both halves right rather than only one.
 *
 * Snapshots are real git commit objects, but unreferenced ones — they do not
 * appear in the log, on a branch, or in `git status`. Nothing here changes what
 * the user would see in their own terminal until they ask to restore.
 *
 * The rule that makes this safe: **restoring takes a snapshot first**. Whatever
 * state is being replaced becomes a checkpoint of its own, so no sequence of
 * restores can reach a state nobody can get back to.
 */

export type Snapshot = {
  /** An unreferenced commit holding the tree. */
  commit: string
  /** True when there was nothing to record — a clean tree at HEAD. */
  clean: boolean
}

export class NotARepositoryForCheckpoint extends Error {
  constructor(repoPath: string) {
    super(`${repoPath} is not a git repository, so there is nothing to snapshot`)
    this.name = 'NotARepositoryForCheckpoint'
  }
}

/**
 * Capture the working tree, including files git is not tracking yet.
 *
 * Staging into a temporary index rather than the real one: `git add -A` would
 * otherwise stage the user's work as a side effect of us taking a backup, and
 * they would find their own staging area rearranged by something they did not
 * do.
 */
export async function takeSnapshot(repoPath: string): Promise<Snapshot> {
  const head = await git(repoPath, ['rev-parse', 'HEAD'])
  if (head === undefined) throw new NotARepositoryForCheckpoint(repoPath)

  const indexDir = await mkdtemp(path.join(os.tmpdir(), 'harness-index-'))
  const indexFile = path.join(indexDir, 'index')

  try {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    // Seed from HEAD so the snapshot is a diff against it rather than a tree
    // built from nothing.
    await run('git', ['read-tree', 'HEAD'], { cwd: repoPath, env, windowsHide: true })
    await run('git', ['add', '-A'], { cwd: repoPath, env, windowsHide: true })
    const { stdout: tree } = await run('git', ['write-tree'], {
      cwd: repoPath,
      env,
      windowsHide: true,
    })

    const headTree = await git(repoPath, ['rev-parse', 'HEAD^{tree}'])
    if (tree.trim() === headTree) return { commit: head, clean: true }

    const { stdout: commit } = await run(
      'git',
      ['commit-tree', tree.trim(), '-p', head, '-m', 'harness checkpoint'],
      { cwd: repoPath, windowsHide: true },
    )
    return { commit: commit.trim(), clean: false }
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Put the working tree back to a snapshot.
 *
 * Returns a snapshot of what was replaced, so the caller can offer to undo the
 * undo. Files the agent created after the checkpoint are removed — that is what
 * "go back" means — but they are inside the returned snapshot, so nothing is
 * actually gone.
 */
export async function restoreSnapshot(repoPath: string, commit: string): Promise<Snapshot> {
  const replaced = await takeSnapshot(repoPath)

  // Anything that exists now and did not exist at the checkpoint. Computed
  // against the snapshot we just took rather than the live tree, so untracked
  // files are included.
  const added = await git(repoPath, [
    'diff',
    '--name-only',
    '--diff-filter=A',
    commit,
    replaced.commit,
  ])
  for (const file of (added ?? '').split('\n').filter((line) => line.trim() !== '')) {
    await rm(path.join(repoPath, file), { force: true }).catch(() => undefined)
  }

  // Restore the contents of everything the checkpoint knew about. `-- .`
  // deliberately scopes this to the tree and leaves HEAD and the branch alone:
  // a rollback is not a commit, and it must not move the user's branch.
  await run('git', ['checkout', commit, '--', '.'], { cwd: repoPath, windowsHide: true })

  return replaced
}

/** Files that differ between a snapshot and the working tree right now. */
export async function changedSince(repoPath: string, commit: string): Promise<string[]> {
  const now = await takeSnapshot(repoPath)
  const out = await git(repoPath, ['diff', '--name-only', commit, now.commit])
  return (out ?? '').split('\n').filter((line) => line.trim() !== '')
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 20000 })
    return stdout.trim()
  } catch {
    return undefined
  }
}
