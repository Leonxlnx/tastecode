// @vitest-environment happy-dom
import { afterAll, bench, describe, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { PullRequestListItem, PullRequestListResult } from '@harness/contracts'
import { TestTransport } from '../../test-transport.js'
import { PullRequestsView } from './PullRequestsView.js'

vi.mock('./PullRequestDetailPane.js', () => ({
  PullRequestDetailPane: ({ item }: { item: PullRequestListItem }) => (
    <div data-testid="pull-request-detail">{item.title}</div>
  ),
}))

const OPTIONS = { iterations: 80, time: 0, warmupIterations: 20, warmupTime: 0 }
const items: PullRequestListItem[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: `PR_${index}`,
  repository: `Blueemi/project-${index % 50}`,
  number: index + 1,
  title: `Pull request ${index}`,
  url: `https://github.com/Blueemi/project-${index % 50}/pull/${index + 1}`,
  author: { login: `author-${index % 20}`, isBot: false },
  updatedAt: new Date(Date.UTC(2026, 7, 23, 12, 0, index)).toISOString(),
  isDraft: false,
  state: 'OPEN',
  additions: index + 10,
  deletions: index + 2,
  commentsCount: index % 7,
  headRefName: `feature/change-${index}`,
  baseRefName: 'main',
  reviewDecision: index % 2 === 0 ? 'APPROVED' : 'REVIEW_REQUIRED',
  mergeStateStatus: index % 2 === 0 ? 'CLEAN' : 'BLOCKED',
  relationship: index % 2 === 0 ? 'authored' : 'reviewing',
}))
const result: PullRequestListResult = {
  account: { available: true, authenticated: true, login: 'Blueemi' },
  fetchedAt: Date.now(),
  truncated: false,
  items,
}
const transport = new TestTransport(async (method) => {
  if (method === 'pullRequests.list') return result
  throw new Error(`Unexpected request: ${method}`)
})
const view = render(
  <PullRequestsView
    transport={transport}
    onOpenChat={() => undefined}
    onSetupTerminalOpen={() => undefined}
  />,
)
await waitFor(() => {
  if (view.container.querySelectorAll('.pr-list-item').length !== items.length) {
    throw new Error('Pull request list is not ready')
  }
})
const rows = [...view.container.querySelectorAll<HTMLButtonElement>('.pr-list-item')]
let selectLast = true

afterAll(() => {
  cleanup()
})

describe('large pull-request list selection', () => {
  bench(
    'selects between rows in a 1,000-item list',
    () => {
      selectLast = !selectLast
      fireEvent.click(selectLast ? rows.at(-1)! : rows[0]!)
    },
    OPTIONS,
  )
})
