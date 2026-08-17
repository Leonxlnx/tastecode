// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  methods,
  type PullRequestDetail,
  type PullRequestMetadataOptions,
} from '@harness/contracts'
import { TestTransport, type TestRequestResolver } from '../../test-transport.js'
import { PullRequestDetailPane } from './PullRequestDetailPane.js'

afterEach(cleanup)

const detail: PullRequestDetail = {
  id: 'PR_7',
  repository: 'Blueemi/harness',
  number: 7,
  title: 'Editable pull request',
  url: 'https://github.com/Blueemi/harness/pull/7',
  author: { login: 'Blueemi', isBot: false },
  updatedAt: '2026-08-09T12:00:00Z',
  isDraft: true,
  state: 'OPEN',
  additions: 12,
  deletions: 3,
  commentsCount: 0,
  headRefName: 'feature/editable',
  baseRefName: 'main',
  relationship: 'authored',
  body: '',
  createdAt: '2026-08-09T11:00:00Z',
  headRefOid: 'head-oid',
  baseRefOid: 'base-oid',
  changedFiles: 2,
  mergeable: 'MERGEABLE',
  maintainerCanModify: true,
  reviewers: [
    {
      actor: { login: 'alice', isBot: false },
      state: 'REQUESTED',
    },
  ],
  requestedReviewers: [{ login: 'alice', isBot: false }],
  assignees: [],
  labels: [{ name: 'feature', color: '6fbf8e' }],
  milestone: 'Beta',
  checks: [],
  comments: [],
  reviews: [],
  reviewThreads: [],
  reviewThreadsTruncated: false,
  permissions: { canPush: true, canAdmin: false },
  mergeMethods: {
    merge: true,
    rebase: true,
    squash: true,
    deleteBranchOnMerge: false,
  },
}

const metadataOptions: PullRequestMetadataOptions = {
  reviewers: [
    { login: 'alice', isBot: false },
    { login: 'bob', isBot: false },
    { login: 'carol', isBot: false },
  ],
  assignees: [{ login: 'Blueemi', isBot: false }],
  labels: [
    { name: 'feature', color: '6fbf8e', description: 'New functionality' },
    { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
  ],
  milestones: [
    { number: 1, title: 'Beta' },
    { number: 2, title: 'Release' },
  ],
  baseBranches: ['main', 'release'],
  unavailable: [],
  truncated: false,
}

function setup(detailValue: PullRequestDetail = detail) {
  const request = vi.fn<TestRequestResolver>(async (method) => {
    if (method === 'pullRequests.detail') return detailValue
    if (method === 'pullRequests.metadataOptions') return metadataOptions
    if (method === 'pullRequests.action') {
      return { message: 'Pull request updated' }
    }
    throw new Error(`Unexpected request: ${method}`)
  })
  const onChanged = vi.fn()
  const view = render(
    <PullRequestDetailPane
      item={detailValue}
      transport={new TestTransport(request)}
      onOpenChat={vi.fn()}
      onChanged={onChanged}
    />,
  )
  return { request, onChanged, container: view.container }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('PullRequestDetailPane inline editing', () => {
  it('shows activity inside summary above checks', async () => {
    const { container } = setup({
      ...detail,
      checks: [{ name: 'Unit tests', state: 'success' }],
      comments: [
        {
          id: 'comment-1',
          databaseId: 1,
          author: { login: 'reviewer', isBot: false },
          body: 'This comment stays visible in the summary.',
          createdAt: '2026-08-09T11:30:00Z',
          url: 'https://github.com/Blueemi/harness/pull/7#issuecomment-1',
          viewerDidAuthor: false,
        },
      ],
    })

    await screen.findByText('This comment stays visible in the summary.')

    expect(screen.queryByRole('tab', { name: /Activity/ })).toBeNull()
    const activity = screen.getByRole('heading', { name: 'Activity' })
    const checks = screen.getByRole('heading', { name: 'Checks' })
    expect(container.querySelector('.pr-summary')?.contains(activity)).toBe(true)
    expect(activity.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(container.querySelector('.pr-timeline-list')).toBeTruthy()
    expect(container.querySelector('.pr-activity-card > .pr-activity-avatar')).toBeTruthy()
    expect(container.querySelector('.pr-activity-card > .pr-activity-comment')).toBeTruthy()
    expect(container.querySelector('.pr-activity-comment > header')).toBeTruthy()
    expect(container.querySelector('.pr-activity-comment-body > .md')).toBeTruthy()
    expect(screen.getByRole('link', { name: /ago|just now/ }).getAttribute('href')).toBe(
      'https://github.com/Blueemi/harness/pull/7#issuecomment-1',
    )
  })

  it('keeps empty label and milestone triggers at their readable width', async () => {
    setup({ ...detail, labels: [], milestone: undefined })

    await screen.findByText('Editable pull request')

    expect(screen.getByRole('button', { name: 'Manage labels' }).className).toContain(
      'is-shape-preserving',
    )
    expect(screen.getByRole('button', { name: 'Manage milestone' }).className).toContain(
      'is-shape-preserving',
    )
  })

  it('shows no overflow menu or toolbar edit shortcut for a merged pull request', async () => {
    setup({ ...detail, state: 'MERGED', isDraft: false, body: 'Original description' })

    await screen.findByText('Editable pull request')
    expect(screen.queryByRole('button', { name: 'More pull request actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit title and description' })).toBeNull()
  })

  it('edits the title in the summary header without opening a dialog', async () => {
    const { request } = setup()

    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))

    expect(screen.queryByRole('dialog', { name: 'Edit pull request' })).toBeNull()
    const input = screen.getByRole('textbox', { name: 'Pull request title' })
    fireEvent.change(input, { target: { value: 'Updated inline title' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: 'Blueemi/harness',
        number: 7,
        action: { type: 'edit', title: 'Updated inline title' },
      }),
    )
  })

  it('edits the description inside its section without opening a dialog', async () => {
    const { request } = setup({ ...detail, body: 'Original description' })

    await screen.findByText('Original description')
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))

    expect(screen.queryByRole('dialog', { name: 'Edit pull request' })).toBeNull()
    const textarea = screen.getByRole('textbox', { name: 'Pull request description' })
    fireEvent.change(textarea, { target: { value: 'Updated right here' } })
    fireEvent.blur(textarea)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: 'Blueemi/harness',
        number: 7,
        action: { type: 'edit', body: 'Updated right here' },
      }),
    )
  })
})

describe('PullRequestDetailPane metadata controls', () => {
  it('loads GitHub profile images with local initial fallbacks', async () => {
    const { container } = setup()

    await screen.findByText('Editable pull request')
    expect(screen.getByRole('button', { name: 'Request reviewers' }).classList).toContain(
      'is-shape-preserving',
    )
    expect(screen.getByRole('button', { name: 'Manage assignees' }).classList).toContain(
      'is-shape-preserving',
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://avatars.githubusercontent.com/Blueemi?s=64',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage assignees' }))
    await screen.findByRole('textbox', { name: 'Find an assignee' })
    expect(
      document.body.querySelector('img[src*="avatars.githubusercontent.com/Blueemi"]'),
    ).toBeTruthy()
  })

  it('requests a repository collaborator directly from the searchable reviewer picker', async () => {
    const { request, onChanged } = setup()

    expect(await screen.findByText('Editable pull request')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request reviewers' }))

    const search = await screen.findByRole('textbox', { name: 'Request review from…' })
    fireEvent.change(search, { target: { value: 'bob' } })
    fireEvent.click(await screen.findByRole('button', { name: /bob/i }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: 'Blueemi/harness',
        number: 7,
        action: {
          type: 'update_metadata',
          addReviewers: ['bob'],
          removeReviewers: [],
          addAssignees: [],
          removeAssignees: [],
          addLabels: [],
          removeLabels: [],
        },
      }),
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps mutation progress beside the selected metadata row and revalidates silently', async () => {
    const action = deferred<{ message: string }>()
    const revalidation = deferred<PullRequestDetail>()
    let detailRequests = 0
    const request = vi.fn<TestRequestResolver>(async (method) => {
      if (method === 'pullRequests.detail') {
        detailRequests += 1
        return detailRequests === 1 ? detail : revalidation.promise
      }
      if (method === 'pullRequests.metadataOptions') return metadataOptions
      if (method === 'pullRequests.action') return action.promise
      throw new Error(`Unexpected request: ${method}`)
    })
    const onChanged = vi.fn()
    render(
      <PullRequestDetailPane
        item={detail}
        transport={new TestTransport(request)}
        onOpenChat={vi.fn()}
        onChanged={onChanged}
      />,
    )

    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Request reviewers' }))
    const bob = await screen.findByRole('button', { name: /bob/i })
    fireEvent.click(bob)

    expect(bob.getAttribute('aria-busy')).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Request reviewers' }).querySelector('.is-spinning'),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Refresh pull request' }).querySelector('.is-spinning'),
    ).toBeNull()

    await act(async () => action.resolve({ message: 'Review requested' }))

    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedReviewers: expect.arrayContaining([expect.objectContaining({ login: 'bob' })]),
        }),
      ),
    )
    expect(bob.getAttribute('aria-busy')).toBe('false')
    expect(
      screen.getByRole('button', { name: 'Request reviewers' }).querySelector('.is-spinning'),
    ).toBeNull()

    await waitFor(() => expect(detailRequests).toBe(2))
    expect(onChanged).toHaveBeenCalledTimes(1)

    await act(async () =>
      revalidation.resolve({
        ...detail,
        requestedReviewers: [...detail.requestedReviewers, { login: 'bob', isBot: false }],
        reviewers: [
          ...detail.reviewers,
          { actor: { login: 'bob', isBot: false }, state: 'REQUESTED' },
        ],
      }),
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2))
  })

  it.each([
    {
      control: 'Change base branch',
      search: 'Find a branch',
      option: 'release',
      change: { baseRefName: 'release' },
    },
    {
      control: 'Manage assignees',
      search: 'Find an assignee',
      option: 'Blueemi',
      change: { addAssignees: ['Blueemi'] },
    },
    {
      control: 'Manage labels',
      search: 'Find a label',
      option: 'feature',
      change: { removeLabels: ['feature'] },
    },
    {
      control: 'Manage milestone',
      search: 'Find a milestone',
      option: 'No milestone',
      change: { milestone: null },
    },
  ])(
    'updates metadata from the $control repository picker',
    async ({ control, search, option, change }) => {
      const { request } = setup()

      await screen.findByText('Editable pull request')
      fireEvent.click(screen.getByRole('button', { name: control }))
      await screen.findByRole('textbox', { name: search })
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(option, 'i') }))

      await waitFor(() =>
        expect(request).toHaveBeenCalledWith('pullRequests.action', {
          repository: 'Blueemi/harness',
          number: 7,
          action: {
            type: 'update_metadata',
            addReviewers: [],
            removeReviewers: [],
            addAssignees: [],
            removeAssignees: [],
            addLabels: [],
            removeLabels: [],
            ...change,
          },
        }),
      )
    },
  )

  it('exposes every metadata field and changes draft status in place', async () => {
    const { request } = setup()

    expect(await screen.findByRole('button', { name: 'Change base branch' })).toBeTruthy()
    const merge = screen.getByRole('button', { name: 'Merge pull request' })
    expect(merge.classList.contains('pr-toolbar-menu-trigger')).toBe(true)
    expect(merge.querySelector('.pr-toolbar-button.is-primary')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage assignees' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage labels' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage milestone' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Change pull request status' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ready for review' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: 'Blueemi/harness',
        number: 7,
        action: { type: 'set_draft', draft: false },
      }),
    )
  })

  it('posts comments from the compact composer on an open pull request', async () => {
    const { request } = setup()

    const composer = await screen.findByRole('textbox', { name: 'Pull request comment' })
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull()
    fireEvent.change(composer, { target: { value: 'Looks good from the app.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: 'Blueemi/harness',
        number: 7,
        action: { type: 'comment', body: 'Looks good from the app.' },
      }),
    )
  })

  it('reopens a closed draft before marking it ready for review', async () => {
    const { request } = setup({ ...detail, state: 'CLOSED' })

    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Change pull request status' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ready for review' }))

    await waitFor(() => {
      const actions = request.mock.calls
        .filter(([method]) => method === 'pullRequests.action')
        .map(([, params]) => methods['pullRequests.action'].params.parse(params).action)
      expect(actions).toEqual([{ type: 'reopen' }, { type: 'set_draft', draft: false }])
    })
  })
})
