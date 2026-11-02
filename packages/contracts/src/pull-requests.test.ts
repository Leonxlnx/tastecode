import { describe, expect, it } from 'vitest'
import { methods } from './protocol.js'
import {
  GitHubRepositoryNameSchema,
  PullRequestActionSchema,
  PullRequestFilesResultSchema,
  PullRequestListResultSchema,
  PullRequestMetadataOptionsSchema,
} from './pull-requests.js'

describe('pull-request contracts', () => {
  it('requires comparison identities for file requests and responses', () => {
    const request = { repository: 'Blueemi/harness', number: 7 }
    const result = { files: [], page: 1, hasMore: false }
    expect(methods['pullRequests.files'].params.safeParse(request).success).toBe(false)
    expect(
      methods['pullRequests.files'].params.parse({
        ...request,
        expectedHeadOid: 'head',
        expectedBaseOid: 'base',
      }),
    ).toMatchObject({ expectedHeadOid: 'head', expectedBaseOid: 'base' })
    expect(PullRequestFilesResultSchema.safeParse(result).success).toBe(false)
    expect(
      PullRequestFilesResultSchema.parse({
        ...result,
        headRefOid: 'head',
        baseRefOid: 'base',
      }),
    ).toMatchObject({ headRefOid: 'head', baseRefOid: 'base' })
  })

  it('accepts a bounded authored pull-request result', () => {
    const result = {
      account: { available: true, authenticated: true, login: 'blueemi' },
      items: [
        {
          id: 'PR_kwDOExample',
          repository: 'blueemi/harness',
          number: 42,
          title: 'Add pull requests',
          url: 'https://github.com/blueemi/harness/pull/42',
          author: { login: 'blueemi', isBot: false },
          updatedAt: '2026-08-09T12:00:00Z',
          isDraft: false,
          state: 'OPEN',
          additions: 320,
          deletions: 18,
          commentsCount: 4,
          headRefName: 'feature/pull-requests',
          baseRefName: 'main',
          relationship: 'authored',
        },
      ],
      fetchedAt: 1,
      truncated: false,
    }

    expect(PullRequestListResultSchema.parse(result)).toEqual(result)
  })

  it('keeps repository targets to a GitHub owner/name pair', () => {
    expect(GitHubRepositoryNameSchema.parse('Blueemi/harness')).toBe('Blueemi/harness')
    expect(() => GitHubRepositoryNameSchema.parse('../outside')).toThrow()
    expect(() => GitHubRepositoryNameSchema.parse('owner/repo/extra')).toThrow()
  })

  it('requires inline-review coordinates and rejects blank comments', () => {
    expect(
      PullRequestActionSchema.parse({
        type: 'inline_comment',
        body: 'Please cover this branch.',
        commitId: 'abc123',
        path: 'src/example.ts',
        line: 12,
        side: 'RIGHT',
      }),
    ).toBeTruthy()
    expect(() => PullRequestActionSchema.parse({ type: 'comment', body: '' })).toThrow()
    expect(() =>
      PullRequestActionSchema.parse({
        type: 'inline_comment',
        body: 'Comment',
        commitId: 'abc123',
        path: 'src/example.ts',
        line: 0,
        side: 'RIGHT',
      }),
    ).toThrow()
  })

  it('bounds repository metadata options to safe public fields', () => {
    const options = {
      reviewers: [{ login: 'reviewer', isBot: false }],
      assignees: [{ login: 'Blueemi', isBot: false }],
      labels: [{ name: 'area:ui', color: 'D93F0B', description: 'Renderer changes' }],
      milestones: [{ number: 3, title: 'M5 — Visual pass' }],
      baseBranches: ['main', 'nightly'],
      unavailable: [],
      truncated: false,
    }

    expect(PullRequestMetadataOptionsSchema.parse(options)).toEqual(options)
  })
})

describe('checkout pull-request contracts', () => {
  const forCheckout = methods['pullRequests.forCheckout']
  const pullRequest = {
    repository: 'Leonxlnx/tastecode',
    number: 1660,
    title: 'Show the chat pull request',
    url: 'https://github.com/Leonxlnx/tastecode/pull/1660',
    state: 'OPEN',
    isDraft: true,
    reviewDecision: 'REVIEW_REQUIRED',
    checks: 'pending',
    headRefName: 'feature/pr-chip',
    baseRefName: 'nightly',
  }
  const found = {
    available: true,
    branch: 'feature/pr-chip',
    repository: 'Leonxlnx/tastecode',
    defaultBranch: 'main',
    upstream: 'origin/feature/pr-chip',
    ahead: 2,
    pullRequest,
    fetchedAt: 1_760_000_000_000,
  }

  it('asks for a project checkout, optionally a chat and a fresh read', () => {
    const params = { projectPath: 'D:\\project' }
    expect(forCheckout.params.parse(params)).toEqual(params)
    expect(forCheckout.params.parse({ ...params, threadId: 'th1', refresh: true })).toEqual({
      ...params,
      threadId: 'th1',
      refresh: true,
    })
    expect(forCheckout.params.safeParse({ projectPath: '' }).success).toBe(false)
    expect(forCheckout.params.safeParse({ ...params, threadId: '' }).success).toBe(false)
  })

  it('reports the branch pull request, no pull request, or why it cannot look', () => {
    expect(forCheckout.result.parse(found)).toEqual(found)
    const none = { available: true, branch: 'feature/new', fetchedAt: 1 }
    expect(forCheckout.result.parse(none)).toEqual(none)
    for (const state of ['OPEN', 'CLOSED', 'MERGED'])
      expect(
        forCheckout.result.parse({ ...found, pullRequest: { ...pullRequest, state } }).pullRequest
          ?.state,
      ).toBe(state)
    for (const checks of ['passing', 'failing', 'pending', 'none'])
      expect(
        forCheckout.result.parse({ ...found, pullRequest: { ...pullRequest, checks } }).pullRequest
          ?.checks,
      ).toBe(checks)
    for (const reason of [
      'not_git',
      'no_branch',
      'detached',
      'no_remote',
      'gh_missing',
      'signed_out',
      'failed',
    ])
      expect(forCheckout.result.parse({ available: false, reason, fetchedAt: 1 }).reason).toBe(
        reason,
      )
    expect(
      forCheckout.result.parse({
        available: false,
        reason: 'gh_missing',
        branch: 'b',
        fetchedAt: 1,
      }).branch,
    ).toBe('b')
  })

  it.each([
    ['unavailable without a reason', { available: false }],
    ['a reason on a lookup that ran', { reason: 'failed' }],
    ['a pull request on an unavailable lookup', { available: false, reason: 'failed' }],
    ['an unknown reason', { available: false, reason: 'offline', pullRequest: undefined }],
    ['negative ahead', { ahead: -1 }],
    ['fractional ahead', { ahead: 0.5 }],
    ['a bad repository', { repository: '../outside' }],
    ['a non-GitHub url', { pullRequest: { ...pullRequest, url: 'https://example.com/pull/1' } }],
    ['an unknown check summary', { pullRequest: { ...pullRequest, checks: 'green' } }],
    ['an empty head', { pullRequest: { ...pullRequest, headRefName: '' } }],
    ['a missing fetch time', { fetchedAt: undefined }],
  ])('rejects a checkout result with %s', (_name, change) => {
    expect(forCheckout.result.safeParse({ ...found, ...change }).success).toBe(false)
  })

  it('commits with a stdin message and pushes without any command text', () => {
    const commit = methods['workspace.commit']
    const params = {
      projectPath: 'D:\\project',
      message: 'feat: add chip\n\nWhy.',
      includeUntracked: true,
    }
    expect(commit.params.parse(params)).toEqual(params)
    expect(commit.params.parse({ ...params, threadId: 'th1' }).threadId).toBe('th1')
    expect(commit.params.safeParse({ ...params, message: '' }).success).toBe(false)
    expect(commit.params.safeParse({ ...params, message: ' \n ' }).success).toBe(false)
    expect(commit.params.safeParse({ ...params, message: 'x'.repeat(10_001) }).success).toBe(false)
    expect(commit.params.safeParse({ projectPath: 'D:\\project', message: 'm' }).success).toBe(
      false,
    )
    const sha1 = 'a'.repeat(40)
    expect(commit.result.parse({ commit: sha1, branch: 'feature/pr-chip' })).toEqual({
      commit: sha1,
      branch: 'feature/pr-chip',
    })
    expect(commit.result.parse({ commit: 'b'.repeat(64) }).commit).toHaveLength(64)
    for (const bad of ['abc123', 'A'.repeat(40), 'a'.repeat(41)])
      expect(commit.result.safeParse({ commit: bad }).success).toBe(false)

    const push = methods['workspace.push']
    expect(push.params.parse({ projectPath: 'D:\\project', threadId: 'th1' })).toEqual({
      projectPath: 'D:\\project',
      threadId: 'th1',
    })
    expect(push.result.parse({ branch: 'feature/pr-chip', remote: 'origin' })).toEqual({
      branch: 'feature/pr-chip',
      remote: 'origin',
    })
    expect(push.result.safeParse({ branch: 'feature/pr-chip' }).success).toBe(false)
  })

  it('creates a pull request with bounded text and a plain base branch', () => {
    const create = methods['pullRequests.create']
    const params = {
      projectPath: 'D:\\project',
      threadId: 'th1',
      title: 'Show the chat pull request',
      body: '',
      base: 'nightly',
      draft: true,
    }
    expect(create.params.parse(params)).toEqual(params)
    const { base: _base, ...withoutBase } = params
    expect(create.params.parse(withoutBase).base).toBeUndefined()
    for (const change of [
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(257) },
      { body: 'x'.repeat(1_000_001) },
      { base: '' },
      { base: '--force' },
      { base: 'two words' },
      { draft: undefined },
    ])
      expect(create.params.safeParse({ ...params, ...change }).success).toBe(false)
    const result = {
      repository: 'Leonxlnx/tastecode',
      number: 1660,
      url: 'https://github.com/Leonxlnx/tastecode/pull/1660',
    }
    expect(create.result.parse(result)).toEqual(result)
    expect(create.result.safeParse({ ...result, url: 'https://example.com/x' }).success).toBe(false)
    expect(create.result.safeParse({ ...result, number: 0 }).success).toBe(false)
  })
})
