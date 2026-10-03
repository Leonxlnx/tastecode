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
