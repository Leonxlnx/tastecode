import { captureCli, spawnCli } from '@harness/proc/cli'

const HEADS = 'refs/heads/'
const READ_TIMEOUT_MS = 10_000
// Commit hooks (formatters, lint-staged) and a credential helper's first
// sign-in can take far longer than a read.
const WRITE_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 4 * 1024 * 1024
const ERROR_LINES = 4
const ERROR_LENGTH = 600

export type GitCommandResult = { code: number; stdout: string; stderr: string }

/** One git process in a checkout. Never throws: a process that cannot start or finish is code -1. */
export type GitCommand = (
  cwd: string,
  args: string[],
  options?: { stdin?: string; timeoutMs?: number },
) => Promise<GitCommandResult>

export const runGitCommand: GitCommand = async (cwd, args, options = {}) => {
  try {
    // A credential prompt has no terminal to answer it; fail instead of waiting.
    const child = spawnCli('git', args, { cwd, env: { GIT_TERMINAL_PROMPT: '0' } })
    const captured = captureCli(child, options.timeoutMs ?? READ_TIMEOUT_MS, OUTPUT_LIMIT)
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin)
    const { code, stdout, stderr } = await captured
    return { code: code ?? -1, stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return {
      code: -1,
      stdout: '',
      stderr: /could not start/i.test(message)
        ? 'Git could not start. Check that it is installed.'
        : 'Git did not finish in time.',
    }
  }
}

/**
 * Commit the checkout's changes with the user's message.
 *
 * Stages every change the Review tab shows, untracked files included when
 * asked, and commits it. A project opened at a repository subfolder reviews
 * only that folder, so only that folder is staged and committed; changes the
 * user staged elsewhere stay staged. The message travels on stdin.
 */
export async function commitCheckout(
  cwd: string,
  request: { message: string; includeUntracked: boolean },
  git: GitCommand = runGitCommand,
): Promise<{ commit: string; branch?: string }> {
  const prefix = await git(cwd, ['rev-parse', '--show-prefix'])
  if (prefix.code !== 0) throw new Error('This folder is not a git checkout.')
  // A path-limited commit is refused during a merge, so the repository root
  // commits without one.
  const scope = prefix.stdout.trim() ? ['--', '.'] : []

  // Staging would mark a conflicted file resolved with its markers still in it.
  const unmerged = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
  if (unmerged.code !== 0) throw gitError(unmerged, 'Git could not read the changes.')
  if (unmerged.stdout.trim()) throw new Error('Resolve the merge conflicts before committing.')

  const staged = await git(
    cwd,
    ['add', request.includeUntracked ? '--all' : '--update', ...scope],
    {
      timeoutMs: WRITE_TIMEOUT_MS,
    },
  )
  if (staged.code !== 0) throw gitError(staged, 'Git could not stage the changes.')

  const committed = await git(cwd, ['commit', '--quiet', '--file=-', ...scope], {
    stdin: request.message,
    timeoutMs: WRITE_TIMEOUT_MS,
  })
  if (committed.code !== 0) {
    if (/nothing (?:added )?to commit|no changes added to commit/i.test(output(committed))) {
      throw new Error('There is nothing to commit.')
    }
    throw gitError(committed, 'Git did not create the commit.')
  }

  const [head, ref] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(cwd, ['symbolic-ref', '--quiet', 'HEAD']),
  ])
  const commit = head.stdout.trim()
  if (head.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new Error('Git created the commit but did not report it.')
  }
  const branch = branchOf(ref)
  return { commit, ...(branch ? { branch } : {}) }
}

/**
 * Push the checked-out branch to a branch of the same name and track it.
 *
 * The remote is the branch's push or upstream remote, else `origin`, else the
 * only remote. Never forces: a remote that moved on refuses the push.
 * Pushing under the same name means a branch that tracks `main` never
 * pushes into `main`.
 */
export async function pushCheckout(
  cwd: string,
  git: GitCommand = runGitCommand,
): Promise<{ branch: string; remote: string }> {
  const head = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
  if (head.code === 128 || head.code === -1) throw new Error('This folder is not a git checkout.')
  const ref = head.stdout.trim()
  const branch = branchOf(head)
  if (!branch) throw new Error('Check out a branch before pushing.')

  const [tracking, remotes] = await Promise.all([
    git(cwd, [
      'for-each-ref',
      '--format=%(refname)%00%(push:remotename)%00%(upstream:remotename)',
      ref,
    ]),
    git(cwd, ['remote']),
  ])
  const fields = tracking.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${ref}\u0000`))
    ?.split('\u0000')
  // HEAD names a branch with no commit yet.
  if (!fields) throw new Error('Commit something before pushing.')

  const names = remotes.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
  const configured = [fields[1], fields[2]].find((name) => name && names.includes(name))
  const remote =
    configured ?? (names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined)
  if (!remote) {
    throw new Error(
      names.length
        ? 'This branch has no upstream and the checkout has several remotes. Push it once from a terminal to choose one.'
        : 'This checkout has no remote to push to.',
    )
  }

  const pushed = await git(
    cwd,
    ['push', '--set-upstream', '--end-of-options', remote, `${ref}:${ref}`],
    { timeoutMs: WRITE_TIMEOUT_MS },
  )
  if (pushed.code !== 0) {
    if (/\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)/.test(pushed.stderr)) {
      throw new Error(
        `${remote} has commits this branch does not have. Pull them first, then push again.`,
      )
    }
    throw gitError(pushed, 'Git could not push the branch.')
  }
  return { branch, remote }
}

function branchOf(result: GitCommandResult): string | undefined {
  const ref = result.code === 0 ? result.stdout.trim() : ''
  return ref.startsWith(HEADS) && ref.length > HEADS.length ? ref.slice(HEADS.length) : undefined
}

function output(result: GitCommandResult): string {
  return `${result.stderr}\n${result.stdout}`
}

/** Git's own explanation, without hints, and never a credential embedded in a remote URL. */
export function gitError(result: GitCommandResult, fallback: string): Error {
  const lines = output(result)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^hint:/i.test(line) && !/^To \S+$/.test(line))
  const text = withoutCredentials(lines.slice(0, ERROR_LINES).join('\n'))
  return new Error(text.slice(0, ERROR_LENGTH) || fallback)
}

function withoutCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
}
