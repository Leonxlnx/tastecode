import type { DomainEvent } from '@harness/contracts'
import type { GuardianApprovalReviewAction } from './generated/v2/GuardianApprovalReviewAction.js'
import type { GuardianApprovalReviewStatus } from './generated/v2/GuardianApprovalReviewStatus.js'
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification.js'
import type { ItemGuardianApprovalReviewStartedNotification } from './generated/v2/ItemGuardianApprovalReviewStartedNotification.js'

const STATUS: Record<
  GuardianApprovalReviewStatus,
  'in_progress' | 'approved' | 'denied' | 'timed_out' | 'aborted'
> = {
  inProgress: 'in_progress',
  approved: 'approved',
  denied: 'denied',
  timedOut: 'timed_out',
  aborted: 'aborted',
}

export function mapAutoReviewNotification(
  method: string,
  params: unknown,
): DomainEvent | undefined {
  if (method === 'item/autoApprovalReview/started') {
    const p = params as ItemGuardianApprovalReviewStartedNotification
    return {
      type: 'approval.review.started',
      review: {
        id: p.reviewId,
        turnId: p.turnId,
        status: 'in_progress',
        description: describeAction(p.action),
        ...(p.review.rationale ? { rationale: p.review.rationale } : {}),
        ...(p.review.riskLevel ? { riskLevel: p.review.riskLevel } : {}),
        startedAt: p.startedAtMs,
      },
    }
  }

  if (method === 'item/autoApprovalReview/completed') {
    const p = params as ItemGuardianApprovalReviewCompletedNotification
    return {
      type: 'approval.review.completed',
      review: {
        id: p.reviewId,
        turnId: p.turnId,
        status: STATUS[p.review.status],
        description: describeAction(p.action),
        ...(p.review.rationale ? { rationale: p.review.rationale } : {}),
        ...(p.review.riskLevel ? { riskLevel: p.review.riskLevel } : {}),
        startedAt: p.startedAtMs,
        completedAt: p.completedAtMs,
      },
    }
  }

  return undefined
}

function describeAction(action: GuardianApprovalReviewAction): string {
  switch (action.type) {
    case 'command':
      return action.command
    case 'execve':
      return [action.program, ...action.argv].join(' ')
    case 'applyPatch':
      return action.files.length === 1
        ? `Edit ${action.files[0]}`
        : `Edit ${action.files.length} files`
    case 'networkAccess':
      return `Connect to ${action.host}:${action.port}`
    case 'mcpToolCall':
      return action.toolTitle ?? `${action.server}: ${action.toolName}`
    case 'requestPermissions':
      return action.reason ?? 'Request additional permissions'
  }
}
