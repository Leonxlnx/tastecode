import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { canonicalCheckoutRoot } from './checkout-access.js'

const run = promisify(execFile)

/** Snapshot commits by (repo, head, tree), so identical state reuses one. */
const snapshotCommits = new Map<string, string>()

/**
 * A point a session can be returned to.
 *
 * An agent that has gone the wrong way for five turns leaves the user undoing
 * it by hand. A checkpoint is a snapshot of the working tree taken before the
 * agent writes, plus the point in the conversation it belongs to, so going back
 * puts both halves right rather than only one.
 *
 * Snapshots are real git commit objects protected by app-owned refs — they do not
 * appear in the log, on a branch, or in `git status`. Nothing here changes what
 * the user would see in their own terminal until they ask to restore.
 *
 * The rule that makes this safe: **restoring takes a snapshot first**. Whatever
 * state is being replaced becomes a checkpoint of its own, so no sequence of
 * restores can reach a state nobody can get back to.
 */

export type Snapshot = {
  /** A commit holding the tree, protected from Git garbage collection. */
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
  const scope = path.relative(canonicalCheckoutRoot(repoPath), realpathSync(repoPath)) || '.'
  repoPath = canonicalCheckoutRoot(repoPath)
  const head = await git(repoPath, ['rev-parse', 'HEAD'])
  if (head === undefined) throw new NotARepositoryForCheckpoint(repoPath)

  const indexDir = await mkdtemp(path.join(os.tmpdir(), 'harness-index-'))
  const indexFile = path.join(indexDir, 'index')

  try {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile }
    // Timeouts throughout: a hung git here leaves every diff/review RPC above
    // this pending forever. Seed from HEAD so the snapshot is a diff against
    // it rather than a tree built from nothing.
    await run('git', ['read-tree', 'HEAD'], {
      cwd: repoPath,
      env,
      windowsHide: true,
      timeout: 60_000,
    })
    await run('git', ['add', '-A', '--', `:(literal)${scope}`], {
      cwd: repoPath,
      env,
      windowsHide: true,
      timeout: 60_000,
    })
    const { stdout: tree } = await run('git', ['write-tree'], {
      cwd: repoPath,
      env,
      windowsHide: true,
      timeout: 60_000,
    })

    const headTree = await git(repoPath, ['rev-parse', 'HEAD^{tree}'])
    if (tree.trim() === headTree) {
      await protectSnapshot(repoPath, head)
      return { commit: head, clean: true }
    }

    // Identical working state must reuse its snapshot commit: commit objects
    // embed a timestamp, so re-running commit-tree for the same tree litters
    // the object database with a fresh dangling commit per diff render.
    const cacheKey = `${repoPath}\0${head}\0${tree.trim()}`
    const cached = snapshotCommits.get(cacheKey)
    if (cached && (await git(repoPath, ['cat-file', '-e', `${cached}^{commit}`])) !== undefined) {
      await protectSnapshot(repoPath, cached)
      return { commit: cached, clean: false }
    }

    const { stdout: commit } = await run(
      'git',
      ['commit-tree', tree.trim(), '-p', head, '-m', 'harness checkpoint'],
      { cwd: repoPath, windowsHide: true, timeout: 60_000 },
    )
    snapshotCommits.set(cacheKey, commit.trim())
    await protectSnapshot(repoPath, commit.trim())
    if (snapshotCommits.size > 64) {
      const oldest = snapshotCommits.keys().next().value
      if (oldest !== undefined) snapshotCommits.delete(oldest)
    }
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
export async function restoreSnapshot(
  repoPath: string,
  commit: string,
  namespace?: string,
): Promise<Snapshot> {
  const replaced = await takeSnapshot(repoPath)
  if (namespace) await retainCheckpoint(repoPath, namespace, replaced.commit)
  const scope = path.relative(canonicalCheckoutRoot(repoPath), realpathSync(repoPath)) || '.'
  repoPath = canonicalCheckoutRoot(repoPath)
  assertCommit(commit)

  // Anything that exists now and did not exist at the checkpoint. Computed
  // against the snapshot we just took rather than the live tree, so untracked
  // files are included.
  // `-z`: with git's default quotePath, a non-ASCII filename comes out
  // escape-quoted, the rm below silently no-ops, and the restore is partial
  // without any error. NUL-delimited output is always the literal path.
  const added = await git(repoPath, [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=A',
    commit,
    replaced.commit,
    '--',
    `:(literal)${scope}`,
  ])
  if (added === undefined) throw new Error('could not list files to restore')
  for (const file of (added ?? '').split('\0').filter((line) => line.trim() !== '')) {
    await rm(path.join(repoPath, file), { force: true })
  }

  // `restore --worktree` rather than `checkout`: checkout writes the index as
  // well, so a rollback would stage everything it touched and hand the user a
  // staging area they did not arrange. Nothing here moves HEAD or the branch
  // either — a rollback restores files, it is not a commit.
  await run('git', ['restore', '--source', commit, '--worktree', '--', `:(literal)${scope}`], {
    cwd: repoPath,
    windowsHide: true,
    timeout: 60_000,
  })

  return replaced
}

/** Files that differ between a snapshot and the working tree right now. */
export async function changedSince(repoPath: string, commit: string): Promise<string[]> {
  const now = await takeSnapshot(repoPath)
  const root = canonicalCheckoutRoot(repoPath)
  const scope = path.relative(root, realpathSync(repoPath)) || '.'
  const out = await git(root, [
    'diff',
    '--name-only',
    '-z',
    commit,
    now.commit,
    '--',
    `:(literal)${scope}`,
  ])
  if (out === undefined) throw new Error('could not read checkpoint changes')
  return (out ?? '').split('\0').filter((line) => line.trim() !== '')
}

const protectedSnapshots = new Map<string, { repoPath: string; commit: string }>()
const SNAPSHOT_CACHE_LIMIT = 64

function assertCommit(commit: string): void {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('invalid checkpoint commit')
}

/** A short cache protects diff-only snapshots; durable metadata uses its own namespace. */
async function protectSnapshot(repoPath: string, commit: string): Promise<void> {
  assertCommit(commit)
  await run('git', ['update-ref', `refs/harness/snapshots/${commit}`, commit], {
    cwd: repoPath,
    windowsHide: true,
    timeout: 20_000,
  })
  const key = `${repoPath}\0${commit}`
  protectedSnapshots.delete(key)
  protectedSnapshots.set(key, { repoPath, commit })
  while (protectedSnapshots.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = protectedSnapshots.entries().next().value!
    protectedSnapshots.delete(oldest[0])
    await git(oldest[1].repoPath, [
      'update-ref',
      '-d',
      `refs/harness/snapshots/${oldest[1].commit}`,
    ])
  }
}

export async function retainCheckpoint(
  repoPath: string,
  namespace: string,
  commit: string,
): Promise<void> {
  assertCommit(commit)
  if (!/^[a-zA-Z0-9-]+$/.test(namespace)) throw new Error('invalid checkpoint namespace')
  await run('git', ['update-ref', `refs/harness/checkpoints/${namespace}/${commit}`, commit], {
    cwd: canonicalCheckoutRoot(repoPath),
    windowsHide: true,
    timeout: 20_000,
  })
}

/** Worktrees share refs and objects even though their writable checkouts are separate. */
export async function checkpointRepository(repoPath: string): Promise<string> {
  const common = await git(repoPath, ['rev-parse', '--git-common-dir'])
  if (common === undefined) throw new Error(`could not locate checkpoint storage for ${repoPath}`)
  return realpathSync(path.resolve(repoPath, common))
}

/** Startup migration writes only missing refs, in bounded Git transactions. */
export async function retainCheckpoints(
  repoPath: string,
  namespace: string,
  commits: ReadonlySet<string>,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]+$/.test(namespace)) throw new Error('invalid checkpoint namespace')
  for (const commit of commits) assertCommit(commit)
  const prefix = `refs/harness/checkpoints/${namespace}/`
  const { stdout } = await run(
    'git',
    ['for-each-ref', '--format=%(refname) %(objectname)', prefix],
    { cwd: repoPath, windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  )
  const protectedCommits = new Set(
    stdout.split('\n').flatMap((line) => {
      const [ref, commit] = line.split(' ')
      return commit && ref === `${prefix}${commit}` ? [commit] : []
    }),
  )
  let commands: string[] = []
  const flush = async () => {
    if (!commands.length) return
    const input = commands.join('\n') + '\n'
    commands = []
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'git',
        ['update-ref', '--stdin'],
        { cwd: repoPath, windowsHide: true, timeout: 20_000 },
        (error) => (error ? reject(error) : resolve()),
      )
      child.stdin?.on('error', reject)
      child.stdin?.end(input)
    })
  }
  for (const commit of commits) {
    if (protectedCommits.has(commit)) continue
    commands.push(`update ${prefix}${commit} ${commit}`)
    if (commands.length >= 256) await flush()
  }
  await flush()
}

/** Explicit offline maintenance can discard diff caches after durable refs are protected. */
export async function clearSnapshotRefs(repoPath: string): Promise<void> {
  const refs = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/harness/snapshots/',
  ])
  if (refs === undefined) throw new Error('could not list snapshot cache references')
  for (const ref of refs.split('\n').filter(Boolean)) {
    await run('git', ['update-ref', '-d', ref], {
      cwd: repoPath,
      windowsHide: true,
      timeout: 20_000,
    })
  }
  snapshotCommits.clear()
  protectedSnapshots.clear()
}

/** Called after explicit history cleanup. Other databases' references stay intact. */
export async function syncCheckpointRefs(
  repoPath: string,
  namespace: string,
  commits: ReadonlySet<string>,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]+$/.test(namespace)) throw new Error('invalid checkpoint namespace')
  for (const commit of commits) await retainCheckpoint(repoPath, namespace, commit)
  const prefix = `refs/harness/checkpoints/${namespace}/`
  const refs = await git(canonicalCheckoutRoot(repoPath), [
    'for-each-ref',
    '--format=%(refname)',
    prefix,
  ])
  if (refs === undefined) throw new Error('could not list checkpoint references')
  for (const ref of refs.split('\n').filter(Boolean)) {
    if (!commits.has(ref.slice(prefix.length)))
      await run('git', ['update-ref', '-d', ref], {
        cwd: canonicalCheckoutRoot(repoPath),
        windowsHide: true,
        timeout: 20_000,
      })
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 20000 })
    return stdout.trim()
  } catch {
    return undefined
  }
}
