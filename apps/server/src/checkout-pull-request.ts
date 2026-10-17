import { execFile } from 'node:child_process'
import {
  CheckoutPullRequestSchema,
  type CheckoutPullRequest,
  type CheckoutPullRequestResult,
  type CheckoutPullRequestUnavailable,
  type PullRequestAccount,
  type PullRequestChecksSummary,
  type PullRequestCreate,
  type PullRequestCreateResult,
} from '@harness/contracts'
import { z } from 'zod'
import {
  checkState,
  githubRepositoryFromRemote,
  normalizeReviewDecision,
  normalizeState,
  RawCheckSchema,
  runGh,
  type GhRunner,
} from './pull-requests.js'

const LOOKUP_TTL_MS = 60_000
/** A lookup that timed out or broke is retried sooner than an answer is refreshed. */
const FAILED_TTL_MS = 15_000
const LOOKUP_CACHE_LIMIT = 64
const CHECKOUT_LIMIT = 256
const GIT_TIMEOUT_MS = 5_000
// The first gh process on a busy Windows machine took over 15 s; the pull
// request list allows the same 30 s.
const GH_TIMEOUT_MS = 30_000
// Creating also resolves the head and base on GitHub before it answers.
const CREATE_TIMEOUT_MS = 60_000
const PULL_REQUEST_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g
const HEADS = 'refs/heads/'
const ORIGIN_HEAD = 'refs/remotes/origin/HEAD'
const ORIGIN_BRANCHES = 'refs/remotes/origin/'
const LOOKUP_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'reviewDecision',
  'statusCheckRollup',
  'headRefName',
  'baseRefName',
  'isCrossRepository',
].join(',')

/** One git command's exit code and output. Never throws; a spawn failure is code -1. */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string }>

type CheckoutGit =
  | { reason: CheckoutPullRequestUnavailable; branch?: string }
  | {
      branch: string
      repository: string
      defaultBranch?: string
      upstream?: string
      ahead?: number
    }

type Lookup =
  | { pullRequest?: CheckoutPullRequest; fetchedAt: number }
  | { reason: 'gh_missing' | 'signed_out' | 'failed'; fetchedAt: number }

/** What `gh repo view --json defaultBranchRef` printed (captured 2026-10-17). */
const RawRepositorySchema = z.object({
  defaultBranchRef: z.object({ name: z.string().min(1) }),
})

const RawLookupSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string().optional(),
    url: z.string().optional(),
    state: z.string().optional(),
    isDraft: z.boolean().optional(),
    reviewDecision: z.string().nullable().optional(),
    statusCheckRollup: z.array(RawCheckSchema).nullable().optional(),
    headRefName: z.string().optional(),
    baseRefName: z.string().optional(),
    isCrossRepository: z.boolean().optional(),
  }),
)

/**
 * The pull request whose head is a chat checkout's branch, for the header chip.
 *
 * Git is read on every call, so a branch switch shows at once. The GitHub
 * lookup is cached per repository and branch for a minute and shared by
 * concurrent callers; a finished turn or a pull-request action drops the entry
 * so the next read sees what the agent or the user just did. Nothing polls.
 */
export class CheckoutPullRequests {
  readonly #run: GhRunner
  readonly #git: GitRunner
  readonly #account: (refresh: boolean) => Promise<PullRequestAccount>
  readonly #now: () => number
  #lookups = new Map<string, { expiresAt: number; value: Lookup }>()
  #inFlight = new Map<string, Promise<Lookup>>()
  /** The lookup key each checkout last resolved to, so a turn can drop it. */
  #keyByCheckout = new Map<string, string>()

  constructor(options: {
    account: (refresh: boolean) => Promise<PullRequestAccount>
    run?: GhRunner
    git?: GitRunner
    now?: () => number
  }) {
    this.#account = options.account
    this.#run = options.run ?? runGh
    this.#git = options.git ?? runGit
    this.#now = options.now ?? Date.now
  }

  async forCheckout(checkout: string, refresh = false): Promise<CheckoutPullRequestResult> {
    const git = await readCheckoutGit(checkout, this.#git)
    if ('reason' in git) {
      return {
        available: false,
        reason: git.reason,
        ...(git.branch ? { branch: git.branch } : {}),
        fetchedAt: this.#now(),
      }
    }

    const { branch, repository, defaultBranch, upstream, ahead } = git
    const found = {
      branch,
      repository,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(upstream ? { upstream } : {}),
      ...(ahead === undefined ? {} : { ahead }),
    }
    // The default branch never has a pull request of its own.
    if (branch === defaultBranch) return { available: true, ...found, fetchedAt: this.#now() }

    const key = lookupKey(repository, branch)
    this.#rememberCheckout(checkout, key)
    const lookup = await this.#lookup(key, repository, branch, refresh)
    if ('reason' in lookup) {
      return { available: false, reason: lookup.reason, branch, fetchedAt: lookup.fetchedAt }
    }
    return {
      available: true,
      ...found,
      ...(lookup.pullRequest ? { pullRequest: lookup.pullRequest } : {}),
      fetchedAt: lookup.fetchedAt,
    }
  }

  /**
   * Open a pull request from the checkout's pushed branch into `base`, else
   * the repository's default branch. gh gets the title as one line and the
   * body on stdin; the lookup for that branch is dropped either way, so the
   * next read shows the new pull request or the one that already existed.
   */
  async create(checkout: string, request: PullRequestCreate): Promise<PullRequestCreateResult> {
    const git = await readCheckoutGit(checkout, this.#git)
    if ('reason' in git) throw new Error(CREATE_REFUSALS[git.reason])
    const { branch, repository } = git
    const sameBranch = () =>
      new Error(`A pull request needs a branch other than ${branch}. Switch branches first.`)
    if (branch === (request.base ?? git.defaultBranch)) throw sameBranch()
    // gh looks for the head by name in the base repository, which is the
    // pushed branch only when origin holds it under the same name.
    if (git.upstream !== `origin/${branch}`) {
      throw new Error('Push the branch before opening a pull request.')
    }

    const key = lookupKey(repository, branch)
    try {
      // Without --base, gh reads a merge-base setting from whatever repository
      // the server happens to run in.
      const base = request.base ?? git.defaultBranch ?? (await this.#defaultBranch(repository))
      if (base === branch) throw sameBranch()
      const output = await this.#run(
        [
          'pr',
          'create',
          `--repo=${repository}`,
          `--head=${branch}`,
          `--base=${base}`,
          `--title=${request.title.replace(/\s+/g, ' ').trim()}`,
          '--body-file=-',
          ...(request.draft ? ['--draft'] : []),
        ],
        { stdin: request.body, timeoutMs: CREATE_TIMEOUT_MS },
      ).catch((error: unknown) => {
        throw createFailure(error, branch, base)
      })
      // gh prints the new pull request's URL; a terminal would get more text first.
      const created = [...output.matchAll(PULL_REQUEST_URL)].at(-1)
      if (!created?.[1] || !created[2]) {
        throw new Error('GitHub CLI did not report the new pull request. Check it on GitHub.')
      }
      return { repository: created[1], number: Number(created[2]), url: created[0] }
    } finally {
      this.#drop(key)
    }
  }

  async #defaultBranch(repository: string): Promise<string> {
    const output = await this.#run(['repo', 'view', repository, '--json', 'defaultBranchRef'], {
      timeoutMs: GH_TIMEOUT_MS,
    })
    const parsed = RawRepositorySchema.safeParse(parseJsonOrUndefined(output))
    if (!parsed.success)
      throw new Error(`GitHub did not say which branch ${repository} merges into.`)
    return parsed.data.defaultBranchRef.name
  }

  /** A turn finished in this checkout: its agent may have pushed or opened a pull request. */
  invalidateCheckout(checkout: string): void {
    const key = this.#keyByCheckout.get(checkout)
    if (key !== undefined) this.#drop(key)
  }

  /** A pull-request action changed state, review or checks somewhere in this repository. */
  invalidateRepository(repository: string): void {
    const prefix = `${repository.toLowerCase()}\u0000`
    for (const key of [...this.#lookups.keys(), ...this.#inFlight.keys()]) {
      if (key.startsWith(prefix)) this.#drop(key)
    }
  }

  #drop(key: string): void {
    this.#lookups.delete(key)
    // A lookup already running may have read GitHub before the change.
    this.#inFlight.delete(key)
  }

  #rememberCheckout(checkout: string, key: string): void {
    this.#keyByCheckout.delete(checkout)
    this.#keyByCheckout.set(checkout, key)
    if (this.#keyByCheckout.size > CHECKOUT_LIMIT) {
      const oldest = this.#keyByCheckout.keys().next().value
      if (oldest !== undefined) this.#keyByCheckout.delete(oldest)
    }
  }

  #lookup(key: string, repository: string, branch: string, refresh: boolean): Promise<Lookup> {
    const now = this.#now()
    const cached = this.#lookups.get(key)
    if (cached && cached.expiresAt <= now) this.#lookups.delete(key)
    else if (cached && !refresh) return Promise.resolve(cached.value)
    const existing = this.#inFlight.get(key)
    if (existing) return existing

    const pending = this.#readGitHub(repository, branch)
      .then((value) => {
        if (this.#inFlight.get(key) === pending) {
          const settledAt = this.#now()
          const ttl = 'reason' in value && value.reason === 'failed' ? FAILED_TTL_MS : LOOKUP_TTL_MS
          this.#lookups.delete(key)
          this.#lookups.set(key, { value, expiresAt: settledAt + ttl })
          for (const [cachedKey, entry] of this.#lookups) {
            if (entry.expiresAt <= settledAt) this.#lookups.delete(cachedKey)
          }
          while (this.#lookups.size > LOOKUP_CACHE_LIMIT) {
            const oldest = this.#lookups.keys().next().value
            if (oldest === undefined) break
            this.#lookups.delete(oldest)
          }
        }
        return value
      })
      .finally(() => {
        if (this.#inFlight.get(key) === pending) this.#inFlight.delete(key)
      })
    this.#inFlight.set(key, pending)
    return pending
  }

  async #readGitHub(repository: string, branch: string): Promise<Lookup> {
    let output: string
    try {
      output = await this.#run(
        [
          'pr',
          'list',
          '--repo',
          repository,
          '--head',
          branch,
          '--state',
          'all',
          '--limit',
          '5',
          '--json',
          LOOKUP_FIELDS,
        ],
        { timeoutMs: GH_TIMEOUT_MS },
      )
    } catch {
      // Ask why only on failure, so a working lookup costs one gh process.
      const account = await this.#account(true).catch(() => undefined)
      const reason =
        account?.available === false
          ? 'gh_missing'
          : account?.authenticated === false
            ? 'signed_out'
            : 'failed'
      return { reason, fetchedAt: this.#now() }
    }

    const fetchedAt = this.#now()
    let items: z.infer<typeof RawLookupSchema>
    try {
      items = RawLookupSchema.parse(JSON.parse(output))
    } catch {
      return { reason: 'failed', fetchedAt }
    }
    // --head matches the branch name in any fork too, so a stranger's pull
    // request from their own "main" would otherwise land on this checkout.
    const own = items.filter((item) => item.isCrossRepository !== true)
    // gh lists the newest first; an open pull request wins over older closed ones.
    const raw = own.find((item) => normalizeState(item.state) === 'OPEN') ?? own[0]
    if (!raw) return { fetchedAt }
    const reviewDecision = normalizeReviewDecision(raw.reviewDecision)
    const pullRequest = CheckoutPullRequestSchema.safeParse({
      repository: repositoryFromPullRequestUrl(raw.url) ?? repository,
      number: raw.number,
      title: raw.title ?? '',
      url: raw.url,
      state: normalizeState(raw.state),
      isDraft: raw.isDraft === true,
      ...(reviewDecision ? { reviewDecision } : {}),
      checks: foldChecks(raw.statusCheckRollup),
      headRefName: raw.headRefName || branch,
      ...(raw.baseRefName ? { baseRefName: raw.baseRefName } : {}),
    })
    return pullRequest.success
      ? { pullRequest: pullRequest.data, fetchedAt }
      : { reason: 'failed', fetchedAt }
  }
}

/** Branch, upstream and GitHub repository of a checkout, or why there is none. */
export async function readCheckoutGit(cwd: string, git: GitRunner): Promise<CheckoutGit> {
  const head = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
  // symbolic-ref exits 1 for a detached HEAD and 128 outside a repository.
  if (head.code === 1) return { reason: 'detached' }
  if (head.code === 128) return { reason: 'not_git' }
  if (head.code !== 0) return { reason: 'failed' }
  const ref = head.stdout.trim()
  if (!ref.startsWith(HEADS)) return { reason: 'detached' }
  const branch = ref.slice(HEADS.length)

  const [refs, remote] = await Promise.all([
    git(cwd, [
      'for-each-ref',
      '--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(symref)',
      ref,
      ORIGIN_HEAD,
    ]),
    git(cwd, ['config', '--get', 'remote.origin.url']),
  ])
  if (refs.code !== 0) return { reason: 'failed', branch }

  let branchLine: string[] | undefined
  let defaultBranch: string | undefined
  for (const line of refs.stdout.split(/\r?\n/)) {
    const fields = line.split('\u0000')
    if (fields[0] === ref) branchLine = fields
    else if (fields[0] === ORIGIN_HEAD && fields[3]?.startsWith(ORIGIN_BRANCHES)) {
      defaultBranch = fields[3].slice(ORIGIN_BRANCHES.length)
    }
  }
  // HEAD names a branch that has no commit yet.
  if (!branchLine) return { reason: 'no_branch', branch }

  const repository = remote.code === 0 ? githubRepositoryFromRemote(remote.stdout) : undefined
  if (!repository) return { reason: 'no_remote', branch }

  const upstream = branchLine[1]
  const track = branchLine[2] ?? ''
  // A gone upstream was deleted on the remote; the branch needs a push again.
  const tracked = upstream && track !== 'gone' ? upstream : undefined
  return {
    branch,
    repository,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(tracked ? { upstream: tracked, ahead: Number(/\bahead (\d+)/.exec(track)?.[1] ?? 0) } : {}),
  }
}

/** All checks folded into one word, the way GitHub's own status icon reads. */
export function foldChecks(
  rollup: ReadonlyArray<z.infer<typeof RawCheckSchema>> | null | undefined,
): PullRequestChecksSummary {
  if (!rollup?.length) return 'none'
  let pending = false
  for (const check of rollup) {
    const state = checkState(check)
    if (state === 'failure' || state === 'cancelled') return 'failing'
    if (state === 'pending') pending = true
  }
  return pending ? 'pending' : 'passing'
}

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (!error) resolve({ code: 0, stdout })
        else resolve({ code: typeof error.code === 'number' ? error.code : -1, stdout: '' })
      },
    )
  })

/** Why a checkout cannot open a pull request, as the user should read it. */
const CREATE_REFUSALS = {
  not_git: 'This folder is not a git checkout.',
  no_branch: 'Commit something before opening a pull request.',
  detached: 'Check out a branch before opening a pull request.',
  no_remote: 'This checkout has no GitHub remote named origin.',
  gh_missing: 'Install the GitHub CLI to open pull requests.',
  signed_out: 'Sign in to the GitHub CLI to open pull requests.',
  failed: 'Git could not read this checkout.',
} satisfies Record<CheckoutPullRequestUnavailable, string>

function createFailure(error: unknown, branch: string, base: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/already exists/i.test(message)) {
    return new Error(`${branch} already has an open pull request into ${base}.`)
  }
  if (/no commits between/i.test(message)) {
    return new Error(`${branch} has no commits that ${base} does not have.`)
  }
  return error instanceof Error ? error : new Error(message)
}

function parseJsonOrUndefined(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function lookupKey(repository: string, branch: string): string {
  return `${repository.toLowerCase()}\u0000${branch}`
}

/** GitHub answers a renamed repository under its current name; the URL carries it. */
function repositoryFromPullRequestUrl(url: string | undefined): string | undefined {
  return url ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] : undefined
}
