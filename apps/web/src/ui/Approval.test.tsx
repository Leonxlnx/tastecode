// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { AutomaticApprovalReview } from './Approval.js'

afterEach(cleanup)

describe('AutomaticApprovalReview', () => {
  it('shows a running review without manual approval controls', () => {
    render(
      <AutomaticApprovalReview
        review={{
          id: 'review-1',
          turnId: 'turn-1',
          status: 'in_progress',
          description: 'Run pnpm test',
          startedAt: 10,
        }}
      />,
    )

    const card = screen.getByRole('status', { name: 'Automatic review: Reviewing access' })
    expect(within(card).getByText('Run pnpm test')).toBeTruthy()
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
  })

  it('shows the final decision, risk, and provider rationale', () => {
    render(
      <AutomaticApprovalReview
        review={{
          id: 'review-1',
          turnId: 'turn-1',
          status: 'approved',
          description: 'Run pnpm test',
          rationale: 'The command only touches the workspace.',
          riskLevel: 'low',
          startedAt: 10,
          completedAt: 20,
        }}
      />,
    )

    const card = screen.getByRole('status', { name: 'Automatic review: Access approved' })
    expect(within(card).getByText('Low risk')).toBeTruthy()
    expect(within(card).getByText('The command only touches the workspace.')).toBeTruthy()
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
  })
})
