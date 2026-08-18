// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('keeps review conversations and inline comments wired through Diffs annotations', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
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
