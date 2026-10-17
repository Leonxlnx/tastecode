import { describe, expect, it } from 'vitest'
import type { CheckoutPullRequest, CheckoutPullRequestResult } from '@harness/contracts'
import { pullRequestFromCommit, reviewGitState } from './review-git.js'

function checkout(overrides: Partial<CheckoutPullRequestResult> = {}): CheckoutPullRequestResult {
  return {
    available: true,
    branch: 'feature/review',
    repository: 'Leonxlnx/tastecode',
    defaultBranch: 'main',
    upstream: 'origin/feature/review',
    ahead: 0,
    fetchedAt: 1,
    ...overrides,
  }
}

const pullRequest = (state: CheckoutPullRequest['state']): CheckoutPullRequest => ({
  repository: 'Leonxlnx/tastecode',
  number: 7,
  title: 'feat: review',
  url: 'https://github.com/Leonxlnx/tastecode/pull/7',
  state,
  isDraft: false,
  headRefName: 'feature/review',
})

describe('what the Review toolbar offers', () => {
  it('offers nothing without a branch', () => {
    expect(reviewGitState(undefined)).toEqual({})
    expect(reviewGitState({ available: false, reason: 'detached', fetchedAt: 1 })).toEqual({})
    expect(
      reviewGitState({ available: false, reason: 'no_branch', branch: 'main', fetchedAt: 1 }),
    ).toEqual({})
  })

  it('pushes commits the upstream lacks and publishes a GitHub branch never pushed', () => {
    expect(reviewGitState(checkout({ ahead: 2 })).push).toEqual({
      ahead: 2,
      upstream: 'origin/feature/review',
    })
    expect(reviewGitState(checkout({ upstream: undefined, ahead: undefined })).push).toEqual({
      ahead: 0,
    })
    // Another host: pushable once tracked, but its first push happens elsewhere.
    const elsewhere = { available: false, reason: 'no_remote', fetchedAt: 1 } as const
    expect(
      reviewGitState({ ...elsewhere, branch: 'main', upstream: 'origin/main', ahead: 1 }).push,
    ).toEqual({ ahead: 1, upstream: 'origin/main' })
    expect(reviewGitState({ ...elsewhere, branch: 'main' })).toEqual({})
  })

  it('opens a pull request only from a pushed, up to date feature branch without an open one', () => {
    expect(reviewGitState(checkout()).createPullRequest).toEqual({
      branch: 'feature/review',
      base: 'main',
    })
    expect(reviewGitState(checkout({ ahead: 1 })).createPullRequest).toBeUndefined()
    expect(
      reviewGitState(checkout({ branch: 'main', upstream: 'origin/main' })).createPullRequest,
    ).toBeUndefined()
    expect(reviewGitState(checkout({ upstream: 'origin/main' })).createPullRequest).toBeUndefined()
    expect(
      reviewGitState(checkout({ pullRequest: pullRequest('OPEN') })).createPullRequest,
    ).toBeUndefined()
    expect(
      reviewGitState(checkout({ pullRequest: pullRequest('MERGED') })).createPullRequest,
    ).toBeDefined()
  })

  it('still pushes but cannot open a pull request while gh is signed out', () => {
    const state = reviewGitState(checkout({ available: false, reason: 'signed_out', ahead: 1 }))
    expect(state.push).toBeDefined()
    expect(
      reviewGitState(checkout({ available: false, reason: 'signed_out' })).createPullRequest,
    ).toBeUndefined()
  })
})

describe('a commit message as a pull request', () => {
  it('takes the first line as the title and the rest as the body', () => {
    expect(pullRequestFromCommit('feat: one\r\n\r\nWhy.\nMore.\n')).toEqual({
      title: 'feat: one',
      body: 'Why.\nMore.',
    })
    expect(pullRequestFromCommit(undefined)).toEqual({ title: '', body: '' })
  })
})
