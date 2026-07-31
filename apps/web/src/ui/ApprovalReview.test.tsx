// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ApprovalReview as ApprovalReviewModel } from '@harness/contracts'
import { ApprovalReview } from './ApprovalReview.js'

afterEach(cleanup)

const review = (status: ApprovalReviewModel['status']): ApprovalReviewModel => ({
  id: 'review-1',
  turnId: 'turn-1',
  status,
  description: 'Connect to example.com:443',
  rationale: 'This endpoint is required by the task.',
  riskLevel: 'low',
  startedAt: 10,
  ...(status === 'in_progress' ? {} : { completedAt: 20 }),
})

describe('ApprovalReview', () => {
  it('shows review progress', () => {
    render(<ApprovalReview review={review('in_progress')} />)
    expect(screen.getByRole('status', { name: 'Reviewing permission' })).toBeTruthy()
    expect(screen.getByText('Connect to example.com:443')).toBeTruthy()
  })

  it.each([
    ['approved', 'Permission approved'],
    ['denied', 'Permission denied'],
    ['timed_out', 'Review timed out'],
    ['aborted', 'Review aborted'],
  ] as const)('shows a %s result', (status, label) => {
    render(<ApprovalReview review={review(status)} />)
    expect(screen.getByRole('note', { name: label })).toBeTruthy()
    expect(screen.getByText('low risk')).toBeTruthy()
    expect(screen.getByText('This endpoint is required by the task.')).toBeTruthy()
  })
})
