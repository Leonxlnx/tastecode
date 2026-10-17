import type { CheckoutPullRequest, CheckoutPullRequestResult } from '@harness/contracts'

/** What the Review toolbar can offer for the checkout's branch. */
export type ReviewGitState = {
  /** Push commits the remote lacks, or publish a branch that was never pushed. */
  push?: { ahead: number; upstream?: string }
  /** The pushed branch can open a pull request into `base` (the default branch). */
  createPullRequest?: { branch: string; base?: string }
  pullRequest?: CheckoutPullRequest
}

const NO_BRANCH = new Set(['not_git', 'no_branch', 'detached'])
const NO_GITHUB = new Set(['gh_missing', 'signed_out'])

export function reviewGitState(checkout: CheckoutPullRequestResult | undefined): ReviewGitState {
  if (!checkout?.branch || (checkout.reason && NO_BRANCH.has(checkout.reason))) return {}
  const { branch, upstream, ahead = 0, repository, defaultBranch } = checkout
  const pullRequest = checkout.available ? checkout.pullRequest : undefined
  // A branch that was never pushed is published to origin, which only a
  // GitHub checkout is known to have; another host needs its first push elsewhere.
  const push = upstream
    ? ahead > 0
      ? { ahead, upstream }
      : undefined
    : repository
      ? { ahead: 0 }
      : undefined
  // gh finds the head by name on origin, so only a branch pushed there under
  // its own name and fully up to date can open one.
  const canCreate =
    repository !== undefined &&
    branch !== defaultBranch &&
    upstream === `origin/${branch}` &&
    ahead === 0 &&
    pullRequest?.state !== 'OPEN' &&
    !(checkout.reason && NO_GITHUB.has(checkout.reason))
  return {
    ...(push ? { push } : {}),
    ...(canCreate
      ? { createPullRequest: { branch, ...(defaultBranch ? { base: defaultBranch } : {}) } }
      : {}),
    ...(pullRequest ? { pullRequest } : {}),
  }
}

/** A commit message as a pull request: its first line is the title, the rest the body. */
export function pullRequestFromCommit(message: string | undefined) {
  const lines = (message ?? '').replace(/\r\n?/g, '\n').trim().split('\n')
  return { title: lines[0]?.trim() ?? '', body: lines.slice(1).join('\n').trim() }
}
