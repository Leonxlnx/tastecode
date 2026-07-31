import { describe, expect, it } from 'vitest'
import { APPROVAL } from './adapter.js'
import { mapAutoReviewNotification } from './auto-review.js'

describe('Codex automatic approval review', () => {
  it('starts workspace-sandboxed threads with the automatic reviewer', () => {
    expect(APPROVAL['auto-review']).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
    })
    expect(APPROVAL.auto).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
  })

  it('maps review progress and the terminal decision', () => {
    const action = {
      type: 'networkAccess' as const,
      target: 'api',
      host: 'example.com',
      protocol: 'https' as const,
      port: 443,
    }

    expect(
      mapAutoReviewNotification('item/autoApprovalReview/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 10,
        reviewId: 'review-1',
        targetItemId: null,
        review: {
          status: 'inProgress',
          riskLevel: null,
          userAuthorization: null,
          rationale: null,
        },
        action,
      }),
    ).toEqual({
      type: 'approval.review.started',
      review: {
        id: 'review-1',
        turnId: 'turn-1',
        status: 'in_progress',
        description: 'Connect to example.com:443',
        startedAt: 10,
      },
    })

    expect(
      mapAutoReviewNotification('item/autoApprovalReview/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 10,
        completedAtMs: 20,
        reviewId: 'review-1',
        targetItemId: null,
        decisionSource: 'agent',
        review: {
          status: 'denied',
          riskLevel: 'high',
          userAuthorization: 'low',
          rationale: 'The host is unrelated to the task.',
        },
        action,
      }),
    ).toEqual({
      type: 'approval.review.completed',
      review: {
        id: 'review-1',
        turnId: 'turn-1',
        status: 'denied',
        description: 'Connect to example.com:443',
        rationale: 'The host is unrelated to the task.',
        riskLevel: 'high',
        startedAt: 10,
        completedAt: 20,
      },
    })
  })
})
