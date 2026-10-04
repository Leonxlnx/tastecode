import { describe, expect, it, vi } from 'vitest'
import type { GhRunner } from './pull-requests.js'
import {
  githubRepositoryFromRemote,
  githubSetupCommand,
  PullRequestService,
} from './pull-requests.js'

const comparison = { headRefOid: 'head-a', baseRefOid: 'base' }

const authored = pullRequest({
  id: 'PR_authored',
  number: 7,
  title: 'Authored change',
  repository: 'Blueemi/harness',
  updatedAt: '2026-08-09T12:00:00Z',
})

const reviewing = pullRequest({
  id: 'PR_reviewing',
  number: 9,
  title: 'Needs my review',
  repository: 'friend/project',
  updatedAt: '2026-08-09T13:00:00Z',
})

const historicalDraft = pullRequest({
  id: 'PR_draft',
  number: 5,
  title: 'Earlier draft',
  repository: 'Blueemi/harness',
  // Newer history sorts ahead of older active work.
  updatedAt: '2026-08-10T11:00:00Z',
  state: 'CLOSED',
  isDraft: true,
})

describe('GitHub CLI setup commands', () => {
  it('uses the official platform install command and fixed login command', () => {
    expect(githubSetupCommand('install', 'darwin')).toBe('brew install gh')
    expect(githubSetupCommand('install', 'win32')).toBe('winget install --id GitHub.cli')
    expect(githubSetupCommand('login', 'linux')).toBe('gh auth login')
    expect(() => githubSetupCommand('install', 'linux')).toThrow(/not scripted/)
  })
})

describe('PullRequestService', () => {
  it('combines authored and reviewing history across states without duplicating a pull request', async () => {
    const run = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: 'Blueemi' })
      const qualifier =
        args.find((argument) => argument.startsWith('q=')) ??
        (args.includes('--author')
          ? 'author:@me'
          : args.includes('--review-requested')
            ? 'review-requested:@me'
            : 'reviewed-by:@me')
      const nodes = qualifier.includes('author:@me')
        ? [authored, historicalDraft]
        : qualifier.includes('review-requested:@me')
          ? [authored, reviewing]
          : [reviewing]
      return args[0] === 'search'
        ? JSON.stringify(nodes.map(searchItem))
        : searchPage(nodes.filter((item) => item.state === 'OPEN'))
    })
    const service = new PullRequestService({
      run,
      installed: async () => true,
      now: () => 100,
      resolveProjects: async () => new Map([['blueemi/harness', '/work/harness']]),
    })

    const result = await service.list(['/work/harness'])

    expect(result.account.login).toBe('Blueemi')
    expect(result.items.map((item) => item.id)).toEqual(['PR_draft', 'PR_reviewing', 'PR_authored'])
    expect(result.items.find((item) => item.id === 'PR_authored')).toMatchObject({
      relationship: 'both',
      localProjectPath: '/work/harness',
    })
    expect(result.items.find((item) => item.id === 'PR_reviewing')?.relationship).toBe('reviewing')
    expect(result.items.find((item) => item.id === 'PR_draft')).toMatchObject({
      state: 'CLOSED',
      isDraft: true,
      relationship: 'authored',
    })

    await service.list(['/work/harness'])
    expect(run).toHaveBeenCalledTimes(7)

    await service.action('Blueemi/harness', 7, { type: 'set_draft', draft: true })
    const afterAction = await service.list(['/work/harness'])
    expect(afterAction.items.find((item) => item.id === 'PR_authored')).toMatchObject({
      state: 'OPEN',
      isDraft: true,
    })
    // The mutation is one gh process. Returning to the list reuses and patches
    // the complete cache instead of launching all six searches again.
    expect(run).toHaveBeenCalledTimes(8)
  })

  it('loads detail, checks, review threads, permissions, and repository merge settings', async () => {
    const run = vi.fn<GhRunner>(async (args) => {
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login: 'Blueemi' })
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          ...authored,
          body: 'A useful description',
          createdAt: '2026-08-08T10:00:00Z',
          closedAt: null,
          mergedAt: null,
          headRefOid: 'abc123',
          baseRefOid: 'def456',
          changedFiles: 2,
          mergeable: 'MERGEABLE',
          maintainerCanModify: true,
          autoMergeRequest: null,
          reviewRequests: [{ login: 'pending-reviewer' }],
          assignees: [{ login: 'Blueemi' }],
          labels: [{ name: 'feature', color: '6fbf8e' }],
          milestone: { title: 'Beta' },
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              name: 'test',
              workflowName: 'Checks',
              status: 'COMPLETED',
              conclusion: 'SUCCESS',
              detailsUrl: 'https://github.com/Blueemi/harness/actions/runs/1',
            },
          ],
          comments: [
            {
              id: 'IC_1',
              databaseId: 11,
              author: { login: 'Blueemi' },
              body: 'hello',
              createdAt: '2026-08-09T10:00:00Z',
              url: 'https://github.com/Blueemi/harness/pull/7#issuecomment-11',
            },
          ],
          reviews: [
            {
              id: 'PRR_1',
              author: { login: 'reviewer' },
              body: 'Looks good',
              state: 'APPROVED',
              submittedAt: '2026-08-09T11:00:00Z',
            },
          ],
        })
      }
      if (args[0] === 'api' && args[1] === 'repos/Blueemi/harness') {
        return JSON.stringify({
          allow_merge_commit: false,
          allow_rebase_merge: true,
          allow_squash_merge: true,
          delete_branch_on_merge: true,
          permissions: { maintain: true },
        })
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'PRRT_1',
                      isResolved: false,
                      isOutdated: false,
                      path: 'src/example.ts',
                      line: 12,
                      originalLine: 12,
                      comments: {
                        nodes: [
                          {
                            id: 'PRRC_1',
                            databaseId: 22,
                            author: { login: 'reviewer' },
                            body: 'Could this be clearer?',
                            createdAt: '2026-08-09T11:30:00Z',
                            url: 'https://github.com/Blueemi/harness/pull/7#discussion_r22',
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      if (args[0] === 'api' && args.includes('--method')) return ''
      if (args[0] === 'pr' && args[1] === 'edit') return ''
      throw new Error(`Unexpected gh call: ${args.join(' ')}`)
    })
    const service = new PullRequestService({
      run,
      installed: async () => true,
      resolveProjects: async () => new Map([['blueemi/harness', '/work/harness']]),
    })

    const detail = await service.detail('Blueemi/harness', 7, ['/work/harness'])

    expect(detail).toMatchObject({
      relationship: 'authored',
      localProjectPath: '/work/harness',
      changedFiles: 2,
      permissions: { canPush: true, canAdmin: false },
      mergeMethods: { merge: false, rebase: true, squash: true, deleteBranchOnMerge: true },
    })
    expect(detail.checks).toEqual([
      expect.objectContaining({ name: 'test', workflowName: 'Checks', state: 'success' }),
    ])
    expect(detail.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({ login: 'reviewer' }),
          state: 'APPROVED',
        }),
        expect.objectContaining({
          actor: expect.objectContaining({ login: 'pending-reviewer' }),
          state: 'REQUESTED',
        }),
      ]),
    )
    expect(detail.reviewThreads[0]).toMatchObject({
      path: 'src/example.ts',
      line: 12,
      resolved: false,
    })
    expect(detail.comments[0]?.viewerDidAuthor).toBe(true)

    await service.action('Blueemi/harness', 7, {
      type: 'update_metadata',
      baseRefName: 'release',
      addReviewers: [],
      removeReviewers: [],
      addAssignees: [],
      removeAssignees: [],
      addLabels: [],
      removeLabels: [],
    })
    await service.detail('Blueemi/harness', 7, ['/work/harness'])

    expect(run.mock.calls.filter(([args]) => args[0] === 'pr' && args[1] === 'view')).toHaveLength(
      2,
    )
    expect(
      run.mock.calls.filter(([args]) => args[0] === 'api' && args[1] === 'repos/Blueemi/harness'),
    ).toHaveLength(1)
    expect(
      run.mock.calls.filter(([args]) => args[0] === 'api' && args[1] === 'graphql'),
    ).toHaveLength(2)
  })

  it('normalizes paged files and keeps comment bodies off the command line', async () => {
    const calls: Array<{ args: string[]; stdin?: string | undefined }> = []
    const run: GhRunner = async (args, options) => {
      calls.push({ args, stdin: options?.stdin })
      if (args.at(-1) === 'headRefOid,baseRefOid') return JSON.stringify(comparison)
      if (args[0] === 'api' && args[1]?.includes('/files?')) {
        return JSON.stringify([
          {
            sha: 'abc123',
            filename: 'src/example.ts',
            status: 'modified',
            additions: 4,
            deletions: 1,
            changes: 5,
            patch: '@@ -1 +1 @@\n-old\n+new',
            blob_url: 'https://github.com/Blueemi/harness/blob/abc/src/example.ts',
          },
        ])
      }
      return ''
    }
    const service = new PullRequestService({ run, installed: async () => true })

    const files = await service.files('Blueemi/harness', 7, comparison)
    expect(files).toMatchObject({
      page: 1,
      hasMore: false,
      files: [{ path: 'src/example.ts', additions: 4, deletions: 1 }],
    })

    const body = 'Body with spaces and `command-looking` text'
    await service.action('Blueemi/harness', 7, { type: 'comment', body })
    const commentCall = calls.at(-1)!
    expect(commentCall.args).toEqual([
      'api',
      '--silent',
      '--method',
      'POST',
      'repos/Blueemi/harness/issues/7/comments',
      '--input',
      '-',
    ])
    expect(commentCall.stdin).toBe(JSON.stringify({ body }))
    expect(commentCall.args).not.toContain(body)
  })

  it('bounds retained pull-request payloads by recent use', async () => {
    const run = vi.fn<GhRunner>(async (args) => {
      if (args.at(-1) === 'headRefOid,baseRefOid') return JSON.stringify(comparison)
      if (args[0] === 'api' && args[1]?.includes('/files?')) return '[]'
      throw new Error(`Unexpected gh call: ${args.join(' ')}`)
    })
    const service = new PullRequestService({ run, installed: async () => true, now: () => 100 })

    for (let number = 1; number <= 13; number += 1) {
      await service.files('Blueemi/harness', number, comparison)
    }
    await service.files('Blueemi/harness', 13, comparison)
    expect(run).toHaveBeenCalledTimes(39)

    // The first large page is outside the 12-entry LRU window and reloads.
    await service.files('Blueemi/harness', 1, comparison)
    expect(run).toHaveBeenCalledTimes(42)
  })

  it('loads and caches repository metadata options while isolating unavailable sources', async () => {
    const run = vi.fn<GhRunner>(async (args) => {
      const endpoint = args[1] ?? ''
      if (endpoint.includes('/collaborators?')) {
        return JSON.stringify([
          [
            { login: 'reviewer', type: 'User' },
            { login: 'dependabot[bot]', type: 'Bot' },
          ],
        ])
      }
      if (endpoint.includes('/assignees?')) {
        return JSON.stringify([[{ login: 'Blueemi', type: 'User' }]])
      }
      if (endpoint.includes('/labels?')) throw new Error('labels unavailable')
      if (endpoint.includes('/milestones?')) {
        return JSON.stringify([[{ number: 3, title: 'M5 — Visual pass' }]])
      }
      if (endpoint.includes('/branches?')) {
        return JSON.stringify([[{ name: 'nightly' }, { name: 'main' }]])
      }
      throw new Error(`Unexpected gh call: ${args.join(' ')}`)
    })
    const service = new PullRequestService({ run, installed: async () => true, now: () => 100 })

    const first = await service.metadataOptions('Blueemi/harness')
    const second = await service.metadataOptions('Blueemi/harness')

    expect(first).toEqual({
      reviewers: [
        { login: 'dependabot[bot]', isBot: true },
        { login: 'reviewer', isBot: false },
      ],
      assignees: [{ login: 'Blueemi', isBot: false }],
      labels: [],
      milestones: [{ number: 3, title: 'M5 — Visual pass' }],
      baseBranches: ['main', 'nightly'],
      unavailable: ['labels'],
      truncated: false,
    })
    expect(second).toEqual(first)
    expect(run).toHaveBeenCalledTimes(5)
    expect(run.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['--paginate', '--slurp']))
  })

  it('maps review, metadata, lifecycle, check, and merge actions to explicit gh operations', async () => {
    const calls: Array<{ args: string[]; stdin?: string | undefined }> = []
    const run: GhRunner = async (args, options) => {
      calls.push({ args, stdin: options?.stdin })
      if (args[0] === 'pr' && args[1] === 'checks') {
        return JSON.stringify([
          {
            bucket: 'fail',
            link: 'https://github.com/Blueemi/harness/actions/runs/88/job/1',
          },
          {
            bucket: 'pass',
            link: 'https://github.com/Blueemi/harness/actions/runs/99/job/2',
          },
        ])
      }
      return ''
    }
    const service = new PullRequestService({ run, installed: async () => true })
    const target = ['Blueemi/harness', 7] as const

    await service.action(...target, {
      type: 'review',
      verdict: 'request_changes',
      body: 'Please add coverage.',
      commitId: 'abc123',
    })
    await service.action(...target, {
      type: 'inline_comment',
      body: 'This branch is unreachable.',
      commitId: 'abc123',
      path: 'src/example.ts',
      line: 14,
      side: 'RIGHT',
    })
    await service.action(...target, {
      type: 'reply_to_review',
      commentId: 45,
      body: 'Fixed in the latest commit.',
    })
    await service.action(...target, {
      type: 'update_comment',
      kind: 'review',
      commentId: 45,
      body: 'Updated review comment.',
    })
    await service.action(...target, {
      type: 'delete_comment',
      kind: 'issue',
      commentId: 46,
    })
    await service.action(...target, {
      type: 'resolve_thread',
      threadId: 'PRRT_1',
      resolved: true,
    })
    await service.action(...target, {
      type: 'edit',
      title: 'Updated title',
      body: 'Updated body',
    })
    await service.action(...target, {
      type: 'update_metadata',
      baseRefName: 'release',
      addReviewers: ['reviewer'],
      removeReviewers: [],
      addAssignees: ['Blueemi'],
      removeAssignees: [],
      addLabels: ['feature'],
      removeLabels: ['needs-triage'],
      milestone: null,
    })
    await service.action(...target, { type: 'set_draft', draft: true })
    await service.action(...target, { type: 'close' })
    await service.action(...target, { type: 'reopen' })
    await service.action(...target, { type: 'update_branch', rebase: true })
    await service.action(...target, { type: 'rerun_checks', failedOnly: true })
    await service.action(...target, {
      type: 'merge',
      method: 'squash',
      deleteBranch: true,
      expectedHeadOid: 'abc123',
    })
    await service.action(...target, {
      type: 'enable_auto_merge',
      method: 'rebase',
      expectedHeadOid: 'abc123',
    })
    await service.action(...target, { type: 'disable_auto_merge' })

    const url = 'https://github.com/Blueemi/harness/pull/7'
    expect(calls).toContainEqual({
      args: [
        'api',
        '--silent',
        '--method',
        'POST',
        'repos/Blueemi/harness/pulls/7/reviews',
        '--input',
        '-',
      ],
      stdin: JSON.stringify({
        event: 'REQUEST_CHANGES',
        body: 'Please add coverage.',
        commit_id: 'abc123',
      }),
    })
    expect(calls).toContainEqual({
      args: [
        'api',
        '--silent',
        '--method',
        'POST',
        'repos/Blueemi/harness/pulls/7/comments',
        '--input',
        '-',
      ],
      stdin: JSON.stringify({
        body: 'This branch is unreachable.',
        commit_id: 'abc123',
        path: 'src/example.ts',
        line: 14,
        side: 'RIGHT',
      }),
    })
    expect(calls).toContainEqual({
      args: [
        'api',
        '--silent',
        '--method',
        'POST',
        'repos/Blueemi/harness/pulls/7/comments/45/replies',
        '--input',
        '-',
      ],
      stdin: JSON.stringify({ body: 'Fixed in the latest commit.' }),
    })
    expect(calls).toContainEqual({
      args: [
        'pr',
        'edit',
        url,
        '--base',
        'release',
        '--add-reviewer',
        'reviewer',
        '--add-assignee',
        'Blueemi',
        '--add-label',
        'feature',
        '--remove-label',
        'needs-triage',
        '--remove-milestone',
      ],
      stdin: undefined,
    })
    expect(calls).toContainEqual({
      args: ['run', 'rerun', '88', '--repo', 'Blueemi/harness', '--failed'],
      stdin: undefined,
    })
    expect(calls).not.toContainEqual(
      expect.objectContaining({ args: expect.arrayContaining(['99']) }),
    )
    expect(calls).toContainEqual({
      args: ['pr', 'merge', url, '--squash', '--match-head-commit', 'abc123', '--delete-branch'],
      stdin: undefined,
    })
    expect(calls).toContainEqual({
      args: ['pr', 'merge', url, '--auto', '--rebase', '--match-head-commit', 'abc123'],
      stdin: undefined,
    })
    expect(calls).toContainEqual({
      args: ['pr', 'merge', url, '--disable-auto'],
      stdin: undefined,
    })
  })

  it.each(['approve', 'comment', 'request_changes'] as const)(
    'binds a %s review to the inspected commit through the API',
    async (verdict) => {
      const run = vi.fn<GhRunner>(async () => '')
      const service = new PullRequestService({ run })
      await service.action('Blueemi/harness', 7, {
        type: 'review',
        verdict,
        body: '',
        commitId: 'reviewed-head',
      })
      expect(run).toHaveBeenCalledWith(
        [
          'api',
          '--silent',
          '--method',
          'POST',
          'repos/Blueemi/harness/pulls/7/reviews',
          '--input',
          '-',
        ],
        {
          stdin: JSON.stringify({
            event:
              verdict === 'approve'
                ? 'APPROVE'
                : verdict === 'comment'
                  ? 'COMMENT'
                  : 'REQUEST_CHANGES',
            body: '',
            commit_id: 'reviewed-head',
          }),
        },
      )
    },
  )

  it.each(['merge', 'enable_auto_merge'] as const)(
    'explains a moved head without retrying %s',
    async (type) => {
      const run = vi.fn<GhRunner>(async () => {
        throw new Error('the head of pull request #7 does not match abc123')
      })
      const service = new PullRequestService({ run })
      await expect(
        service.action('Blueemi/harness', 7, {
          type,
          method: 'squash',
          expectedHeadOid: 'abc123',
          deleteBranch: false,
        }),
      ).rejects.toThrow('Review the latest commits before merging')
      expect(run).toHaveBeenCalledOnce()
      expect(run.mock.calls[0]?.[0]).toContain('--match-head-commit')
    },
  )

  it('invalidates all comparison pages and fences old file reads after a base change', async () => {
    let finishOld!: (value: string) => void
    let filesCalls = 0
    const run = vi.fn<GhRunner>(async (args) => {
      if (args.at(-1) === 'headRefOid,baseRefOid') return JSON.stringify(comparison)
      if (args[1]?.includes('/files?')) {
        filesCalls += 1
        if (filesCalls === 3)
          return new Promise<string>((resolve) => {
            finishOld = resolve
          })
        return '[]'
      }
      return ''
    })
    const service = new PullRequestService({ run })
    await service.files('Blueemi/harness', 7, comparison, 1)
    await service.files('Blueemi/harness', 7, comparison, 2)
    const old = service.files('Blueemi/harness', 7, comparison, 3)
    const rejected = expect(old).rejects.toThrow('comparison changed')
    await vi.waitFor(() => expect(filesCalls).toBe(3))
    await service.action('Blueemi/harness', 7, {
      type: 'update_metadata',
      baseRefName: 'release',
      addReviewers: [],
      removeReviewers: [],
      addAssignees: [],
      removeAssignees: [],
      addLabels: [],
      removeLabels: [],
    })
    await service.files('Blueemi/harness', 7, comparison, 1)
    await service.files('Blueemi/harness', 7, comparison, 2)
    await service.files('Blueemi/harness', 7, comparison, 3)
    finishOld('[]')
    await rejected
    await service.files('Blueemi/harness', 7, comparison, 3)
    expect(filesCalls).toBe(6)
  })

  it('invalidates cached and in-flight file pages when fresh detail observes a new head', async () => {
    let head = 'head-a'
    let finishOld!: (value: string) => void
    let filesCalls = 0
    const run = vi.fn<GhRunner>(async (args) => {
      if (args[1] === 'user') return JSON.stringify({ login: 'Blueemi' })
      if (args[1] === 'view')
        return JSON.stringify({
          ...authored,
          comments: [],
          createdAt: authored.updatedAt,
          headRefOid: head,
          baseRefOid: 'base',
        })
      if (args[1]?.includes('/files?')) {
        filesCalls += 1
        if (filesCalls === 2)
          return new Promise<string>((resolve) => {
            finishOld = resolve
          })
        return '[]'
      }
      return '{}'
    })
    const service = new PullRequestService({ run, installed: async () => true })
    await service.detail('Blueemi/harness', 7, [])
    await service.files('Blueemi/harness', 7, { ...comparison, headRefOid: head })
    const old = service.files('Blueemi/harness', 7, { ...comparison, headRefOid: head }, 2)
    const rejected = expect(old).rejects.toThrow('comparison changed')
    await vi.waitFor(() => expect(filesCalls).toBe(2))
    head = 'head-b'
    expect((await service.detail('Blueemi/harness', 7, [], true)).headRefOid).toBe('head-b')
    await service.files('Blueemi/harness', 7, { ...comparison, headRefOid: head })
    finishOld('[]')
    await rejected
    await service.files('Blueemi/harness', 7, { ...comparison, headRefOid: head }, 2)
    expect(filesCalls).toBe(4)
  })

  it('starts a fresh detail read after a change instead of joining or caching an older one', async () => {
    let title = 'Old title'
    let finishOld!: () => void
    let views = 0
    const run = vi.fn<GhRunner>(async (args) => {
      if (args[1] === 'user') return JSON.stringify({ login: 'Blueemi' })
      if (args[1] === 'view') {
        views += 1
        const value = JSON.stringify({
          ...authored,
          title,
          comments: [],
          createdAt: authored.updatedAt,
          headRefOid: 'head-a',
          baseRefOid: 'base',
        })
        if (views === 1)
          return new Promise<string>((resolve) => {
            finishOld = () => resolve(value)
          })
        return value
      }
      return '{}'
    })
    const service = new PullRequestService({ run, installed: async () => true })
    const old = service.detail('Blueemi/harness', 7, [], true)
    const rejected = expect(old).rejects.toThrow('changed while loading')
    await vi.waitFor(() => expect(views).toBe(1))
    await service.action('Blueemi/harness', 7, { type: 'edit', title: 'New title' })
    title = 'New title'
    const fresh = service.detail('Blueemi/harness', 7, [])
    finishOld()
    await rejected
    expect((await fresh).title).toBe('New title')
    expect((await service.detail('Blueemi/harness', 7, [])).title).toBe('New title')
    expect(views).toBe(2)
  })

  it('keeps detail honest about pending reviews, teams, long threads, and failed reads', async () => {
    let threadsFail = true
    let repositoryFails = false
    const run = vi.fn<GhRunner>(async (args) => {
      if (args[1] === 'user') return JSON.stringify({ login: 'Blueemi' })
      if (args[1] === 'view')
        return JSON.stringify({
          ...authored,
          comments: [],
          createdAt: authored.updatedAt,
          headRefOid: 'head-a',
          baseRefOid: 'base',
          reviewRequests: [{ __typename: 'Team', name: 'Design', slug: 'acme/design' }],
          reviews: [
            {
              id: 'PRR_pending',
              author: { login: 'Blueemi' },
              state: 'PENDING',
              submittedAt: null,
            },
          ],
        })
      if (args[1] === 'repos/Blueemi/harness') {
        if (repositoryFails) throw new Error('repository unavailable')
        return '{}'
      }
      if (args[1] === 'graphql') {
        if (threadsFail) throw new Error('graphql unavailable')
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'PRRT_1',
                      path: 'src/example.ts',
                      comments: {
                        totalCount: 101,
                        nodes: [
                          {
                            id: 'PRRC_1',
                            databaseId: 1,
                            author: { login: 'reviewer' },
                            body: 'First',
                            createdAt: '2026-08-09T11:30:00Z',
                            url: 'https://github.com/Blueemi/harness/pull/7#discussion_r1',
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        })
      }
      return ''
    })
    const service = new PullRequestService({ run, installed: async () => true, now: () => 100 })

    const failed = await service.detail('Blueemi/harness', 7, [])
    expect(failed.reviews).toEqual([])
    expect(failed.requestedReviewers).toEqual([{ login: 'acme/design', isBot: false }])
    expect(failed.reviewThreadsUnavailable).toBe(true)

    threadsFail = false
    const loaded = await service.detail('Blueemi/harness', 7, [])
    expect(loaded.reviewThreadsUnavailable).toBeUndefined()
    expect(loaded.reviewThreads[0]?.commentsTruncated).toBe(true)

    repositoryFails = true
    await expect(service.detail('Blueemi/harness', 7, [], true)).rejects.toThrow(
      'repository unavailable',
    )

    await service.action('Blueemi/harness', 7, {
      type: 'update_metadata',
      addReviewers: [],
      removeReviewers: ['acme/design', 'reviewer'],
      addAssignees: [],
      removeAssignees: [],
      addLabels: [],
      removeLabels: [],
    })
    expect(run).toHaveBeenLastCalledWith(
      [
        'api',
        '--silent',
        '--method',
        'DELETE',
        'repos/Blueemi/harness/pulls/7/requested_reviewers',
        '--input',
        '-',
      ],
      { stdin: JSON.stringify({ reviewers: ['reviewer'], team_reviewers: ['design'] }) },
    )
  })

  it('keeps base branches that differ only by case', async () => {
    const run = vi.fn<GhRunner>(async (args) => {
      if (args[1]?.includes('/branches?')) {
        return JSON.stringify([[{ name: 'release' }, { name: 'Release' }]])
      }
      return '[[]]'
    })
    const service = new PullRequestService({ run, installed: async () => true, now: () => 100 })
    const options = await service.metadataOptions('Blueemi/harness')
    expect(options.baseBranches).toHaveLength(2)
    expect(options.baseBranches).toEqual(expect.arrayContaining(['release', 'Release']))
  })

  it('uses one direct API request for single-picker metadata changes', async () => {
    const calls: Array<{ args: string[]; stdin?: string | undefined }> = []
    const run: GhRunner = async (args, options) => {
      calls.push({ args, stdin: options?.stdin })
      return ''
    }
    const service = new PullRequestService({ run, installed: async () => true })
    const unchanged = {
      addReviewers: [],
      removeReviewers: [],
      addAssignees: [],
      removeAssignees: [],
      addLabels: [],
      removeLabels: [],
    }

    await service.action('Blueemi/harness', 7, {
      type: 'update_metadata',
      ...unchanged,
      addReviewers: ['reviewer'],
    })
    await service.action('Blueemi/harness', 7, {
      type: 'update_metadata',
      ...unchanged,
      removeAssignees: ['Blueemi'],
    })
    await service.action('Blueemi/harness', 7, {
      type: 'update_metadata',
      ...unchanged,
      removeLabels: ['needs triage'],
    })

    expect(calls).toEqual([
      {
        args: [
          'api',
          '--silent',
          '--method',
          'POST',
          'repos/Blueemi/harness/pulls/7/requested_reviewers',
          '--input',
          '-',
        ],
        stdin: JSON.stringify({ reviewers: ['reviewer'] }),
      },
      {
        args: [
          'api',
          '--silent',
          '--method',
          'DELETE',
          'repos/Blueemi/harness/issues/7/assignees',
          '--input',
          '-',
        ],
        stdin: JSON.stringify({ assignees: ['Blueemi'] }),
      },
      {
        args: [
          'api',
          '--silent',
          '--method',
          'DELETE',
          'repos/Blueemi/harness/issues/7/labels/needs%20triage',
        ],
        stdin: undefined,
      },
    ])
  })
})

describe('githubRepositoryFromRemote', () => {
  it.each([
    ['git@github.com:Blueemi/harness.git', 'Blueemi/harness'],
    ['https://github.com/Blueemi/harness.git', 'Blueemi/harness'],
    ['ssh://git@github.com/Blueemi/harness.git', 'Blueemi/harness'],
  ])('reads %s', (remote, expected) => {
    expect(githubRepositoryFromRemote(remote)).toBe(expected)
  })

  it('ignores non-GitHub and malformed remotes', () => {
    expect(githubRepositoryFromRemote('https://gitlab.com/Blueemi/harness.git')).toBeUndefined()
    expect(githubRepositoryFromRemote('not a remote')).toBeUndefined()
  })
})

function pullRequest(input: {
  id: string
  number: number
  title: string
  repository: string
  updatedAt: string
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft?: boolean
}) {
  return {
    id: input.id,
    number: input.number,
    title: input.title,
    url: `https://github.com/${input.repository}/pull/${input.number}`,
    state: input.state ?? 'OPEN',
    isDraft: input.isDraft ?? false,
    updatedAt: input.updatedAt,
    additions: 12,
    deletions: 3,
    comments: { totalCount: 2 },
    author: { login: 'Blueemi' },
    repository: { nameWithOwner: input.repository },
    headRefName: 'feature/change',
    baseRefName: 'main',
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
  }
}

function searchPage(nodes: unknown[]): string {
  return JSON.stringify({
    data: {
      search: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  })
}

function searchItem(item: ReturnType<typeof pullRequest>) {
  return {
    author: item.author,
    commentsCount: item.comments.totalCount,
    id: item.id,
    isDraft: item.isDraft,
    number: item.number,
    repository: item.repository,
    state: item.state.toLowerCase(),
    title: item.title,
    updatedAt: item.updatedAt,
    url: item.url,
  }
}
