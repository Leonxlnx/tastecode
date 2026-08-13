// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PullRequestListResult } from '@harness/contracts'
import type { Transport } from '../../transport.js'
import { PullRequestsView } from './PullRequestsView.js'

afterEach(cleanup)

const result: PullRequestListResult = {
  account: { available: true, authenticated: true, login: 'Blueemi' },
  fetchedAt: Date.now(),
  truncated: false,
  items: [
    {
      id: 'PR_authored',
      repository: 'Blueemi/harness',
      number: 7,
      title: 'Authored change',
      url: 'https://github.com/Blueemi/harness/pull/7',
      author: { login: 'Blueemi', isBot: false },
      updatedAt: '2026-08-09T12:00:00Z',
      isDraft: false,
      state: 'OPEN',
      additions: 12,
      deletions: 3,
      commentsCount: 2,
      headRefName: 'feature/authored',
      baseRefName: 'main',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      relationship: 'authored',
    },
    {
      id: 'PR_reviewing',
      repository: 'friend/project',
      number: 9,
      title: 'Needs my review',
      url: 'https://github.com/friend/project/pull/9',
      author: { login: 'friend', isBot: false },
      updatedAt: '2026-08-09T13:00:00Z',
      isDraft: false,
      state: 'OPEN',
      additions: 8,
      deletions: 1,
      commentsCount: 0,
      headRefName: 'feature/review',
      baseRefName: 'develop',
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED',
      relationship: 'reviewing',
    },
    {
      id: 'PR_draft',
      repository: 'Blueemi/harness',
      number: 6,
      title: 'Closed draft change',
      url: 'https://github.com/Blueemi/harness/pull/6',
      author: { login: 'Blueemi', isBot: false },
      updatedAt: '2026-08-08T12:00:00Z',
      isDraft: true,
      state: 'CLOSED',
      additions: 4,
      deletions: 2,
      commentsCount: 1,
      headRefName: 'feature/draft',
      baseRefName: 'main',
      mergeStateStatus: 'DIRTY',
      relationship: 'authored',
    },
    {
      id: 'PR_merged',
      repository: 'Blueemi/harness',
      number: 5,
      title: 'Merged change',
      url: 'https://github.com/Blueemi/harness/pull/5',
      author: { login: 'Blueemi', isBot: false },
      updatedAt: '2026-08-07T12:00:00Z',
      isDraft: false,
      state: 'MERGED',
      additions: 7,
      deletions: 1,
      commentsCount: 3,
      headRefName: 'feature/merged',
      baseRefName: 'main',
      reviewDecision: 'APPROVED',
      relationship: 'authored',
    },
  ],
}

describe('PullRequestsView', () => {
  it('shows authored and reviewing work, then filters without another request', async () => {
    const never = new Promise<never>(() => undefined)
    const request = vi.fn((method: string) =>
      method === 'pullRequests.list' ? Promise.resolve(result) : never,
    )
    const transport = { request } as unknown as Transport

    render(<PullRequestsView transport={transport} onOpenChat={vi.fn()} />)

    expect(await screen.findByText('Authored change')).toBeTruthy()
    expect(screen.getByText('Needs my review')).toBeTruthy()
    expect(screen.getByText('Closed draft change')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'All 4' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('heading', { name: 'Reviewing' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Authored' })).toBeNull()
    expect(
      Array.from(document.querySelectorAll('.pr-list-item strong')).map((item) => item.textContent),
    ).toEqual(['Authored change', 'Needs my review', 'Closed draft change', 'Merged change'])

    fireEvent.click(screen.getByRole('tab', { name: 'Reviewing 1' }))
    expect(screen.getByText('Needs my review')).toBeTruthy()
    expect(screen.queryByText('Authored change')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Reviewing' })).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search pull requests' }), {
      target: { value: 'no-match' },
    })
    expect(screen.getByText('No matching pull requests')).toBeTruthy()
    expect(request.mock.calls.filter(([method]) => method === 'pullRequests.list')).toHaveLength(1)
  })

  it('filters open, draft, merged, and closed history locally', async () => {
    const never = new Promise<never>(() => undefined)
    const request = vi.fn((method: string) =>
      method === 'pullRequests.list' ? Promise.resolve(result) : never,
    )
    const transport = { request } as unknown as Transport

    render(<PullRequestsView transport={transport} onOpenChat={vi.fn()} />)
    expect(await screen.findByText('Closed draft change')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Filter pull requests: no active filters' }))
    expect(screen.getByRole('menu', { name: 'Pull request filters' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Review Any review/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Merge status Any merge status/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Repository All repositories/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: /State All states/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Drafts/ }))
    expect(screen.getByText('Closed draft change')).toBeTruthy()
    expect(screen.getByText('Closed draft')).toBeTruthy()
    expect(screen.queryByText('Authored change')).toBeNull()
    expect(screen.getByRole('tab', { name: 'All 1' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: /State Drafts/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Merged/ }))
    expect(screen.getByText('Merged change')).toBeTruthy()
    expect(screen.queryByText('Closed draft change')).toBeNull()
    expect(request.mock.calls.filter(([method]) => method === 'pullRequests.list')).toHaveLength(1)
  })

  it('combines review and repository filters and clears them together', async () => {
    const never = new Promise<never>(() => undefined)
    const request = vi.fn((method: string) =>
      method === 'pullRequests.list' ? Promise.resolve(result) : never,
    )
    const transport = { request } as unknown as Transport

    render(<PullRequestsView transport={transport} onOpenChat={vi.fn()} />)
    expect(await screen.findByText('Needs my review')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Filter pull requests: no active filters' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Review Any review/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Review required/ }))
    expect(screen.getByText('Needs my review')).toBeTruthy()
    expect(screen.queryByText('Authored change')).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: /Repository All repositories/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /friend\/project/ }))
    expect(
      screen.getByRole('button', { name: 'Filter pull requests: 2 active filters' }),
    ).toBeTruthy()
    expect(screen.getByText('Needs my review')).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear all' }))
    expect(
      screen.getByRole('button', { name: 'Filter pull requests: no active filters' }),
    ).toBeTruthy()
    expect(screen.getByText('Authored change')).toBeTruthy()
    expect(screen.getByText('Closed draft change')).toBeTruthy()
    expect(request.mock.calls.filter(([method]) => method === 'pullRequests.list')).toHaveLength(1)
  })
})
