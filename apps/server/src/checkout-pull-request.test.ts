import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestAccount } from '@harness/contracts'
import {
  CheckoutPullRequests,
  foldChecks,
  readCheckoutGit,
  runGit,
  type GitRunner,
} from './checkout-pull-request.js'
import type { GhRunner } from './pull-requests.js'

const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  // git on Windows can hold a handle in the folder for a moment after it exits.
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5 })),
  )
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' })
}

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-checkout-pr-'))
  temporary.push(root)
  // Never discover a repository above the temporary folder.
  vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(root))
  return root
}

async function repository(): Promise<string> {
  const root = await folder()
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  return root
}

function commit(root: string, message: string): void {
  git(root, 'commit', '-q', '--allow-empty', '-m', message)
}

describe('reading a checkout with git', () => {
  it('reports a folder outside git, an unborn branch and a detached HEAD', async () => {
    expect(await readCheckoutGit(await folder(), runGit)).toEqual({ reason: 'not_git' })

    const root = await repository()
    expect(await readCheckoutGit(root, runGit)).toEqual({ reason: 'no_branch', branch: 'main' })

    commit(root, 'first')
    git(root, 'checkout', '-q', '--detach')
    expect(await readCheckoutGit(root, runGit)).toEqual({ reason: 'detached' })
  })

  it('needs a GitHub origin', async () => {
    const root = await repository()
    commit(root, 'first')
    expect(await readCheckoutGit(root, runGit)).toEqual({ reason: 'no_remote', branch: 'main' })

    git(root, 'remote', 'add', 'origin', 'https://gitlab.com/team/project.git')
    expect(await readCheckoutGit(root, runGit)).toEqual({ reason: 'no_remote', branch: 'main' })
  })

  it('reads the branch, its upstream, how far ahead it is and the default branch', async () => {
    const root = await repository()
    git(root, 'remote', 'add', 'origin', 'git@github.com:Leonxlnx/personalharness.git')
    commit(root, 'first')
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git(root, 'switch', '-q', '-c', 'feature/pr-chip')
    commit(root, 'pushed')
    git(root, 'update-ref', 'refs/remotes/origin/feature/pr-chip', 'HEAD')
    git(root, 'branch', '-q', '--set-upstream-to=origin/feature/pr-chip')
    commit(root, 'local one')
    commit(root, 'local two')

    expect(await readCheckoutGit(root, runGit)).toEqual({
      branch: 'feature/pr-chip',
      repository: 'Leonxlnx/personalharness',
      defaultBranch: 'main',
      upstream: 'origin/feature/pr-chip',
      ahead: 2,
    })

    git(root, 'switch', '-q', '-c', 'never-pushed')
    expect(await readCheckoutGit(root, runGit)).toEqual({
      branch: 'never-pushed',
      repository: 'Leonxlnx/personalharness',
      defaultBranch: 'main',
    })
  })

  it('treats an upstream deleted on the remote as no upstream', async () => {
    const root = await repository()
    git(root, 'remote', 'add', 'origin', 'https://github.com/Leonxlnx/tastecode.git')
    commit(root, 'first')
    git(root, 'switch', '-q', '-c', 'merged-feature')
    git(root, 'config', 'branch.merged-feature.remote', 'origin')
    git(root, 'config', 'branch.merged-feature.merge', 'refs/heads/merged-feature')

    expect(await readCheckoutGit(root, runGit)).toEqual({
      branch: 'merged-feature',
      repository: 'Leonxlnx/tastecode',
    })
  })
  // Every step spawns git, which takes a while on a busy Windows machine.
}, 120_000)

describe('folding status checks', () => {
  it('reads like the status icon on GitHub', () => {
    const run = (conclusion: string | null, status = 'COMPLETED') => ({
      __typename: 'CheckRun' as const,
      status,
      conclusion,
    })
    expect(foldChecks(undefined)).toBe('none')
    expect(foldChecks([])).toBe('none')
    expect(foldChecks([run('SUCCESS'), run('SKIPPED'), run('NEUTRAL')])).toBe('passing')
    expect(foldChecks([run('SUCCESS'), run(null, 'IN_PROGRESS')])).toBe('pending')
    expect(foldChecks([run(null, 'QUEUED'), run('FAILURE')])).toBe('failing')
    expect(foldChecks([run('SUCCESS'), run('CANCELLED')])).toBe('failing')
    expect(foldChecks([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending')
  })
})

/** What `gh pr list --json …` printed for a real pull request (captured 2026-10-17). */
function listed(overrides: Record<string, unknown> = {}) {
  return {
    baseRefName: 'nightly',
    headRefName: 'feature/pr-chip',
    isCrossRepository: false,
    isDraft: false,
    number: 1676,
    reviewDecision: '',
    state: 'OPEN',
    statusCheckRollup: [],
    title: 'feat(web): glide the transcript end into view while a turn streams',
    url: 'https://github.com/Leonxlnx/tastecode/pull/1676',
    ...overrides,
  }
}

function fakeGit(branch = 'feature/pr-chip'): GitRunner {
  return async (_cwd, args) => {
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: `refs/heads/${branch}\n` }
    if (args[0] === 'config')
      return { code: 0, stdout: 'https://github.com/Leonxlnx/personalharness.git\n' }
    return {
      code: 0,
      stdout:
        `refs/heads/${branch}\u0000origin/${branch}\u0000ahead 1\u0000\n` +
        'refs/remotes/origin/HEAD\u0000\u0000\u0000refs/remotes/origin/main\n',
    }
  }
}

const signedIn: PullRequestAccount = { available: true, authenticated: true, login: 'Leonxlnx' }

function service(
  output: unknown[] | (() => Promise<string>),
  options: { branch?: string; account?: PullRequestAccount; now?: () => number } = {},
) {
  const run = vi.fn<GhRunner>(
    typeof output === 'function' ? output : async () => JSON.stringify(output),
  )
  const account = vi.fn(async () => options.account ?? signedIn)
  const lookups = new CheckoutPullRequests({
    run,
    account,
    git: fakeGit(options.branch),
    now: options.now ?? (() => 1_000),
  })
  return { lookups, run, account }
}

describe('the pull request for a checkout', () => {
  it('reports the branch without a pull request', async () => {
    const { lookups, run } = service([])
    expect(await lookups.forCheckout('/work/project')).toEqual({
      available: true,
      branch: 'feature/pr-chip',
      repository: 'Leonxlnx/personalharness',
      defaultBranch: 'main',
      upstream: 'origin/feature/pr-chip',
      ahead: 1,
      fetchedAt: 1_000,
    })
    expect(run).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--repo',
        'Leonxlnx/personalharness',
        '--head',
        'feature/pr-chip',
        '--state',
        'all',
        '--limit',
        '5',
        '--json',
        'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,headRefName,baseRefName,isCrossRepository',
      ],
      { timeoutMs: 30_000 },
    )
  })

  it('names an open draft with its review and checks under its current repository', async () => {
    const { lookups } = service([
      listed({
        isDraft: true,
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }],
      }),
    ])
    expect((await lookups.forCheckout('/work/project')).pullRequest).toEqual({
      repository: 'Leonxlnx/tastecode',
      number: 1676,
      title: 'feat(web): glide the transcript end into view while a turn streams',
      url: 'https://github.com/Leonxlnx/tastecode/pull/1676',
      state: 'OPEN',
      isDraft: true,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'pending',
      headRefName: 'feature/pr-chip',
      baseRefName: 'nightly',
    })
  })

  it('prefers an open pull request and otherwise shows the newest merged or closed one', async () => {
    const closed = listed({ number: 12, state: 'CLOSED' })
    const open = listed({ number: 9, state: 'OPEN' })
    expect((await service([closed, open]).lookups.forCheckout('/p')).pullRequest?.number).toBe(9)
    const merged = listed({ number: 14, state: 'MERGED', reviewDecision: 'APPROVED' })
    expect((await service([merged, closed]).lookups.forCheckout('/p')).pullRequest).toMatchObject({
      number: 14,
      state: 'MERGED',
      reviewDecision: 'APPROVED',
      checks: 'none',
    })
  })

  it("ignores a fork's pull request from a branch of the same name", async () => {
    // Captured: `gh pr list --head main` on Leonxlnx/tastecode lists a fork's #1237.
    const fork = listed({ number: 1237, state: 'OPEN', isCrossRepository: true })
    const own = listed({ number: 7, state: 'MERGED' })
    expect((await service([fork, own]).lookups.forCheckout('/p')).pullRequest?.number).toBe(7)
    expect((await service([fork]).lookups.forCheckout('/p')).pullRequest).toBeUndefined()
  })

  it('never looks up the default branch', async () => {
    const { lookups, run } = service([listed()], { branch: 'main' })
    expect(await lookups.forCheckout('/p')).toMatchObject({ available: true, branch: 'main' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['gh_missing', { available: false, authenticated: false }],
    ['signed_out', { available: true, authenticated: false }],
    ['failed', signedIn],
  ] as const)('says %s when gh cannot answer', async (reason, account) => {
    const { lookups, account: readAccount } = service(
      async () => {
        throw new Error('gh failed')
      },
      { account },
    )
    expect(await lookups.forCheckout('/p')).toEqual({
      available: false,
      reason,
      branch: 'feature/pr-chip',
      fetchedAt: 1_000,
    })
    expect(readAccount).toHaveBeenCalledWith(true)
  })

  it('treats unreadable gh output as a failed lookup', async () => {
    const { lookups } = service(async () => 'not json')
    expect(await lookups.forCheckout('/p')).toMatchObject({ available: false, reason: 'failed' })
  })

  it('passes a git answer through without asking GitHub', async () => {
    const run = vi.fn<GhRunner>()
    const lookups = new CheckoutPullRequests({
      run,
      account: async () => signedIn,
      git: async () => ({ code: 1, stdout: '' }),
      now: () => 5,
    })
    expect(await lookups.forCheckout('/p')).toEqual({
      available: false,
      reason: 'detached',
      fetchedAt: 5,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('caches a lookup for a minute and shares one that is running', async () => {
    let now = 1_000
    const { lookups, run } = service([listed()], { now: () => now })
    await Promise.all([lookups.forCheckout('/a'), lookups.forCheckout('/b')])
    expect(run).toHaveBeenCalledTimes(1)

    now += 59_000
    expect((await lookups.forCheckout('/a')).fetchedAt).toBe(1_000)
    expect(run).toHaveBeenCalledTimes(1)

    await lookups.forCheckout('/a', true)
    expect(run).toHaveBeenCalledTimes(2)

    now += 61_000
    await lookups.forCheckout('/a')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('tries a failed lookup again after 15 seconds, a missing gh only after a minute', async () => {
    let now = 1_000
    const failing = service(
      async () => {
        throw new Error('GitHub did not respond in time')
      },
      { now: () => now },
    )
    const missing = service(
      async () => {
        throw new Error('spawn gh ENOENT')
      },
      { now: () => now, account: { available: false, authenticated: false } },
    )
    await failing.lookups.forCheckout('/a')
    await missing.lookups.forCheckout('/a')

    now += 14_000
    await failing.lookups.forCheckout('/a')
    expect(failing.run).toHaveBeenCalledTimes(1)
    now += 2_000
    await failing.lookups.forCheckout('/a')
    await missing.lookups.forCheckout('/a')
    expect(failing.run).toHaveBeenCalledTimes(2)
    expect(missing.run).toHaveBeenCalledTimes(1)
  })

  it('looks again after a turn in that checkout or an action in that repository', async () => {
    const { lookups, run } = service([listed()])
    await lookups.forCheckout('/a')
    lookups.invalidateCheckout('/elsewhere')
    await lookups.forCheckout('/a')
    expect(run).toHaveBeenCalledTimes(1)

    lookups.invalidateCheckout('/a')
    await lookups.forCheckout('/a')
    expect(run).toHaveBeenCalledTimes(2)

    lookups.invalidateRepository('leonxlnx/PERSONALHARNESS')
    await lookups.forCheckout('/a')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('does not cache a lookup that was running when its checkout changed', async () => {
    let finish!: (output: string) => void
    const outputs = [
      new Promise<string>((resolve) => (finish = resolve)),
      Promise.resolve(JSON.stringify([listed({ number: 2 })])),
    ]
    const { lookups, run } = service(() => outputs.shift()!)
    const stale = lookups.forCheckout('/a')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    lookups.invalidateCheckout('/a')
    finish(JSON.stringify([listed({ number: 1 })]))
    expect((await stale).pullRequest?.number).toBe(1)

    expect((await lookups.forCheckout('/a')).pullRequest?.number).toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
