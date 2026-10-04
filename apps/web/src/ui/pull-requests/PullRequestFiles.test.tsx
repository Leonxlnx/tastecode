// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { PullRequestDetail } from '@harness/contracts'
import type { Transport } from '../../transport.js'
import { PullRequestFiles } from './PullRequestFiles.js'

vi.mock('./PullRequestDiffRenderer.js', () => ({
  PullRequestDiffRenderer: (props: {
    annotations: unknown[]
    renderAnnotation: (annotation: unknown) => ReactNode
    onCommentLine: (target: { lineNumber: number; side: 'additions' }) => void
  }) => (
    <div data-testid="diffs-renderer">
      <button
        type="button"
        onClick={() => props.onCommentLine({ lineNumber: 2, side: 'additions' })}
      >
        Comment on rendered line
      </button>
      {props.annotations.map((annotation, index) => (
        <div key={index}>{props.renderAnnotation(annotation)}</div>
      ))}
    </div>
  ),
}))

afterEach(cleanup)

const detail: PullRequestDetail = {
  id: 'PR_7',
  repository: 'Blueemi/harness',
  number: 7,
  title: 'Review this change',
  url: 'https://github.com/Blueemi/harness/pull/7',
  author: { login: 'Blueemi', isBot: false },
  updatedAt: '2026-08-09T12:00:00Z',
  isDraft: false,
  state: 'OPEN',
  additions: 1,
  deletions: 1,
  commentsCount: 1,
  headRefName: 'feature/review',
  baseRefName: 'main',
  relationship: 'reviewing',
  body: '',
  createdAt: '2026-08-09T11:00:00Z',
  headRefOid: 'head-oid',
  baseRefOid: 'base-oid',
  changedFiles: 1,
  mergeable: 'MERGEABLE',
  maintainerCanModify: true,
  reviewers: [],
  requestedReviewers: [],
  assignees: [],
  labels: [],
  checks: [],
  comments: [],
  reviews: [],
  reviewThreads: [
    {
      id: 'thread-1',
      path: 'src/example.ts',
      line: 2,
      diffSide: 'RIGHT',
      resolved: false,
      outdated: false,
      comments: [
        {
          id: 'comment-1',
          databaseId: 10,
          author: { login: 'Leonxlnx', isBot: false },
          body: 'Can this be clearer?',
          createdAt: '2026-08-09T11:30:00Z',
          url: 'https://github.com/Blueemi/harness/pull/7#discussion_r10',
          viewerDidAuthor: false,
        },
      ],
    },
  ],
  reviewThreadsTruncated: false,
  permissions: { canPush: true, canAdmin: false },
  mergeMethods: {
    merge: true,
    rebase: true,
    squash: true,
    deleteBranchOnMerge: false,
  },
}

describe('PullRequestFiles', () => {
  function setupFiles(hasMore = false) {
    const request = vi.fn(async () => ({
      headRefOid: detail.headRefOid,
      baseRefOid: detail.baseRefOid,
      files: ['src/example.ts', 'src/other.ts'].map((filePath) => ({
        sha: 'file-oid',
        path: filePath,
        status: 'modified' as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: '@@ -1,2 +1,2 @@\n context\n-old\n+new',
      })),
      page: 1,
      hasMore,
    }))
    const onAction = vi.fn(async () => true)
    const onComparisonChanged = vi.fn()
    render(
      <PullRequestFiles
        detail={{
          ...detail,
          reviewThreads: detail.reviewThreads.map((thread) => ({
            ...thread,
            comments: [
              ...thread.comments,
              { ...thread.comments[0]!, id: 'reply-1', databaseId: 20, body: 'Existing reply' },
            ],
          })),
        }}
        transport={{ request } as unknown as Transport}
        onAction={onAction}
        onComparisonChanged={onComparisonChanged}
        onConfirmAction={vi.fn()}
        actionBusy={false}
      />,
    )
    return { request, onAction, onComparisonChanged }
  }

  it.each(['error', 'identity'] as const)(
    'drops every page and requests detail refresh after a comparison %s mismatch',
    async (kind) => {
      const { request, onComparisonChanged, onAction } = setupFiles(true)
      await screen.findByRole('button', { name: 'Comment on rendered line' })
      if (kind === 'error') {
        request.mockRejectedValueOnce(
          new Error(
            'Pull request comparison changed. Refresh the pull request before reviewing files.',
          ),
        )
      } else {
        request.mockResolvedValueOnce({
          headRefOid: 'other-head',
          baseRefOid: detail.baseRefOid,
          files: [],
          page: 2,
          hasMore: false,
        })
      }
      fireEvent.click(screen.getByRole('button', { name: 'Load more files' }))
      await waitFor(() => expect(onComparisonChanged).toHaveBeenCalledOnce())
      expect(screen.queryByTestId('diffs-renderer')).toBeNull()
      expect(screen.queryByRole('button', { name: /example.ts/ })).toBeNull()
      expect(screen.getByText(/Pull request comparison changed/)).toBeTruthy()
      expect(onAction).not.toHaveBeenCalled()
    },
  )

  it('does not carry an inline draft into another file at the same line', async () => {
    const { request, onAction } = setupFiles()
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on rendered line' }))
    fireEvent.change(screen.getByPlaceholderText('Comment on this line'), {
      target: { value: 'Only for example.ts' },
    })
    fireEvent.click(screen.getByRole('button', { name: /other.ts/ }))
    expect(screen.queryByPlaceholderText('Comment on this line')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on rendered line' }))
    expect((screen.getByPlaceholderText('Comment on this line') as HTMLTextAreaElement).value).toBe(
      '',
    )
    expect(onAction).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('pullRequests.files', {
      repository: detail.repository,
      number: detail.number,
      expectedHeadOid: detail.headRefOid,
      expectedBaseOid: detail.baseRefOid,
      page: 1,
      refresh: true,
    })
  })

  it('replies to the top-level comment from Files after an existing reply', async () => {
    const { onAction } = setupFiles()
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Second reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        type: 'reply_to_review',
        commentId: 10,
        body: 'Second reply',
      }),
    )
  })

  it('keeps a changed inline draft when an earlier send succeeds', async () => {
    const { onAction } = setupFiles()
    let finish!: (success: boolean) => void
    onAction.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on rendered line' }))
    const editor = screen.getByPlaceholderText('Comment on this line')
    fireEvent.change(editor, { target: { value: 'First inline note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    fireEvent.change(editor, { target: { value: 'Another inline note' } })
    await act(async () => finish(true))
    expect((screen.getByPlaceholderText('Comment on this line') as HTMLTextAreaElement).value).toBe(
      'Another inline note',
    )
  })

  it('keeps review conversations and inline comments wired through Diffs annotations', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        headRefOid: detail.headRefOid,
        baseRefOid: detail.baseRefOid,
        files: [
          {
            sha: 'file-oid',
            path: 'src/example.ts',
            status: 'modified' as const,
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1,2 +1,2 @@\n context\n-old\n+new',
          },
        ],
        page: 1,
        hasMore: false,
      }),
    )
    const onAction = vi.fn(() => Promise.resolve(true))

    render(
      <PullRequestFiles
        detail={detail}
        transport={{ request } as unknown as Transport}
        onAction={onAction}
        onComparisonChanged={vi.fn()}
        onConfirmAction={vi.fn()}
        actionBusy={false}
      />,
    )

    expect(
      await screen.findByText('Can this be clearer?', undefined, { timeout: 5_000 }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on rendered line' }))
    const editor = await screen.findByPlaceholderText('Comment on this line')
    fireEvent.change(editor, { target: { value: 'Inline note from TasteCode.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith({
        type: 'inline_comment',
        body: 'Inline note from TasteCode.',
        commitId: 'head-oid',
        path: 'src/example.ts',
        line: 2,
        side: 'RIGHT',
      }),
    )
  })
})
