// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    if (method === 'pullRequests.files')
      return {
        headRefOid: detailValue.headRefOid,
        baseRefOid: detailValue.baseRefOid,
        files: [],
        page: 1,
        hasMore: false,
      }
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

/** Detail replies in order: an Error rejects, anything else resolves; then `detail`. */
function renderScriptedDetail(
  ...replies: Array<PullRequestDetail | Promise<PullRequestDetail> | Error>
) {
  let count = 0
  const request = vi.fn<TestRequestResolver>(async (method) => {
    if (method === 'pullRequests.detail') {
      count += 1
      const reply = replies.shift() ?? detail
      if (reply instanceof Error) throw reply
      return reply
    }
    if (method === 'pullRequests.metadataOptions') return metadataOptions
    throw new Error(`Unexpected request: ${method}`)
  })
  render(
    <PullRequestDetailPane
      item={detail}
      transport={new TestTransport(request)}
      onOpenChat={vi.fn()}
      onChanged={vi.fn()}
    />,
  )
  return { detailRequests: () => count }
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

  it('surfaces a failed refresh as a retryable alert without replacing the loaded detail', async () => {
    const { detailRequests } = renderScriptedDetail(detail, new Error('GitHub is unreachable'))

    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('GitHub is unreachable')
    expect(screen.getByText('Editable pull request')).toBeTruthy()

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(detailRequests()).toBe(3)
    expect(screen.getByText('Editable pull request')).toBeTruthy()
  })

  it('dismisses a failed refresh alert and keeps the loaded detail', async () => {
    renderScriptedDetail(detail, new Error('GitHub is unreachable'))
    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))

    fireEvent.click(
      within(await screen.findByRole('alert')).getByRole('button', { name: 'Dismiss' }),
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Editable pull request')).toBeTruthy()
  })

  it('announces the first load and its failure, then recovers on retry', async () => {
    const first = deferred<PullRequestDetail>()
    renderScriptedDetail(first.promise, detail)

    expect(screen.getByRole('status', { name: 'Loading pull request' })).toBeTruthy()
    first.reject(new Error('GitHub is unreachable'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't open this pull request")
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Editable pull request')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
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

  it('keeps the title editor open for the Enter that confirms an IME conversion', async () => {
    setup()

    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByRole('textbox', { name: 'Pull request title' })
    input.focus()
    fireEvent.change(input, { target: { value: 'にほんご' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.activeElement).not.toBe(input)
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
    const loadingLayer = screen
      .getByRole('button', { name: 'Request reviewers' })
      .querySelector('.is-spinning')
      ?.closest('.icon-morph__layer')
    expect(loadingLayer).toBeTruthy()
    expect(loadingLayer?.hasAttribute('data-active')).toBe(false)

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

  it('ignores a refresh that started before a successful change', async () => {
    const staleRefresh = deferred<PullRequestDetail>()
    let detailRequests = 0
    const request = vi.fn<TestRequestResolver>(async (method) => {
      if (method === 'pullRequests.detail') {
        detailRequests += 1
        if (detailRequests === 1) return detail
        if (detailRequests === 2) return staleRefresh.promise
        return { ...detail, isDraft: false }
      }
      if (method === 'pullRequests.metadataOptions') return metadataOptions
      if (method === 'pullRequests.action') return { message: 'Marked ready for review' }
      throw new Error(`Unexpected request: ${method}`)
    })
    render(
      <PullRequestDetailPane
        item={detail}
        transport={new TestTransport(request)}
        onOpenChat={vi.fn()}
        onChanged={vi.fn()}
      />,
    )
    await screen.findByText('Editable pull request')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    await waitFor(() => expect(detailRequests).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Change pull request status' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ready for review' }))
    await screen.findByText('Marked ready for review')
    expect(
      screen.getByRole('button', { name: 'Refresh pull request' }).querySelector('.is-spinning'),
    ).toBeNull()
    // The server retires the pre-change read instead of returning old data.
    await act(async () =>
      staleRefresh.reject(new Error('Pull request changed while loading. Refresh and try again.')),
    )
    await waitFor(() => expect(detailRequests).toBe(3))
    expect(screen.queryByText(/changed while loading/)).toBeNull()
    expect(screen.getByText('Marked ready for review')).toBeTruthy()
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

describe('PullRequestDetailPane review safety', () => {
  it('pins a merge confirmation to its original head and refreshes after rejection', async () => {
    const initial = { ...detail, isDraft: false }
    const { request, onChanged } = setup(initial)
    await screen.findByText(initial.title)
    fireEvent.click(screen.getByRole('button', { name: 'Merge pull request' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Squash and merge' }))

    request.mockImplementation(async (method) => {
      if (method === 'pullRequests.detail') return { ...initial, headRefOid: 'new-head' }
      if (method === 'pullRequests.action') {
        throw new Error(
          'The pull request head changed since you reviewed it. Review the latest commits before merging.',
        )
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.detail', {
        repository: detail.repository,
        number: detail.number,
        refresh: true,
      }),
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge pull request' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: detail.repository,
        number: detail.number,
        action: {
          type: 'merge',
          method: 'squash',
          expectedHeadOid: 'head-oid',
          deleteBranch: false,
        },
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Review the latest commits')
    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ headRefOid: 'new-head' })),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends the inspected head when enabling auto-merge', async () => {
    const { request } = setup({ ...detail, isDraft: false })
    await screen.findByText(detail.title)
    fireEvent.click(screen.getByRole('button', { name: 'Auto-merge options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Enable with Squash and merge' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: detail.repository,
        number: detail.number,
        action: { type: 'enable_auto_merge', method: 'squash', expectedHeadOid: detail.headRefOid },
      }),
    )
  })

  it('binds approval to the inspected commit', async () => {
    const { request } = setup({ ...detail, relationship: 'reviewing' })
    await screen.findByRole('textbox', { name: 'Pull request comment' })
    fireEvent.click(screen.getByRole('combobox', { name: 'Submission type' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Approve' }))
    fireEvent.click(screen.getByRole('button', { name: 'approved these changes' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: detail.repository,
        number: detail.number,
        action: { type: 'review', verdict: 'approve', body: '', commitId: detail.headRefOid },
      }),
    )
  })

  it('refreshes on focus and coalesces repeated focus notifications', async () => {
    const { request, onChanged } = setup()
    await screen.findByText(detail.title)
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    fireEvent(window, new Event('focus'))
    expect(request.mock.calls.filter(([method]) => method === 'pullRequests.detail')).toHaveLength(
      2,
    )
    expect(request).toHaveBeenCalledWith('pullRequests.detail', {
      repository: detail.repository,
      number: detail.number,
      refresh: true,
    })
  })

  it('keeps a new draft typed while an earlier comment is being sent', async () => {
    const pending = deferred<{ message: string }>()
    const { request } = setup()
    const composer = await screen.findByRole('textbox', { name: 'Pull request comment' })
    request.mockImplementation(async (method) => {
      if (method === 'pullRequests.detail') return detail
      if (method === 'pullRequests.action') return pending.promise
      throw new Error(`Unexpected request: ${method}`)
    })
    fireEvent.change(composer, { target: { value: 'First note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }))
    fireEvent.change(composer, { target: { value: 'Next unsent note' } })
    await act(async () => pending.resolve({ message: 'Comment added' }))
    expect((composer as HTMLTextAreaElement).value).toBe('Next unsent note')
  })

  it('keeps review text and mode when Files unmounts the composer', async () => {
    setup({ ...detail, relationship: 'reviewing' })
    const composer = await screen.findByRole('textbox', { name: 'Pull request comment' })
    fireEvent.click(screen.getByRole('combobox', { name: 'Submission type' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Request changes' }))
    fireEvent.change(composer, { target: { value: 'Please check this edge case.' } })
    fireEvent.click(screen.getByRole('tab', { name: /Files/ }))
    expect(screen.queryByRole('textbox', { name: 'Pull request comment' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }))
    expect(
      (screen.getByRole('textbox', { name: 'Pull request comment' }) as HTMLTextAreaElement).value,
    ).toBe('Please check this edge case.')
    expect(screen.getByRole('combobox', { name: 'Submission type' }).textContent).toBe(
      'Request changes',
    )
  })

  it('reloads visible files on explicit refresh even when the comparison SHAs stay the same', async () => {
    const { request } = setup()
    await screen.findByText(detail.title)
    fireEvent.click(screen.getByRole('tab', { name: /Files/ }))
    await waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === 'pullRequests.files')).toHaveLength(
        1,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    await waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === 'pullRequests.files')).toHaveLength(
        2,
      ),
    )
    expect(request).toHaveBeenCalledWith('pullRequests.files', {
      repository: detail.repository,
      number: detail.number,
      expectedHeadOid: detail.headRefOid,
      expectedBaseOid: detail.baseRefOid,
      page: 1,
      refresh: true,
    })
  })

  it('refreshes detail and reloads Files with the new comparison after a moved-head rejection', async () => {
    const { request } = setup()
    await screen.findByText(detail.title)
    let fileRequests = 0
    request.mockImplementation(async (method) => {
      if (method === 'pullRequests.detail') return { ...detail, headRefOid: 'new-head' }
      if (method === 'pullRequests.files') {
        fileRequests += 1
        if (fileRequests === 1)
          throw new Error(
            'Pull request comparison changed. Refresh the pull request before reviewing files.',
          )
        return {
          headRefOid: 'new-head',
          baseRefOid: detail.baseRefOid,
          files: [],
          page: 1,
          hasMore: false,
        }
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    fireEvent.click(screen.getByRole('tab', { name: /Files/ }))
    await waitFor(() => expect(fileRequests).toBe(2))
    expect(request).toHaveBeenCalledWith('pullRequests.detail', {
      repository: detail.repository,
      number: detail.number,
      refresh: true,
    })
    expect(request).toHaveBeenLastCalledWith('pullRequests.files', {
      repository: detail.repository,
      number: detail.number,
      expectedHeadOid: 'new-head',
      expectedBaseOid: detail.baseRefOid,
      page: 1,
      refresh: true,
    })
  })

  it('replies to the root review comment, not an existing reply', async () => {
    const comment = {
      id: 'root',
      databaseId: 10,
      author: detail.author,
      body: 'Root note',
      createdAt: detail.createdAt,
      url: detail.url,
      viewerDidAuthor: false,
    }
    const { request } = setup({
      ...detail,
      reviewThreads: [
        {
          id: 'thread',
          path: 'src/example.ts',
          resolved: false,
          outdated: false,
          comments: [comment, { ...comment, id: 'reply', databaseId: 20, body: 'Existing reply' }],
        },
      ],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))
    const editor = screen
      .getAllByRole('textbox')
      .find((element) => !element.getAttribute('aria-label'))!
    fireEvent.change(editor, { target: { value: 'Another reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('pullRequests.action', {
        repository: detail.repository,
        number: detail.number,
        action: { type: 'reply_to_review', commentId: 10, body: 'Another reply' },
      }),
    )
  })
})
