import type { ApprovalReview as ApprovalReviewModel } from '@harness/contracts'
import { CircleAlert, LoaderCircle, ShieldCheck, ShieldX } from 'lucide-react'

export function ApprovalReview({ review }: { review: ApprovalReviewModel }) {
  const content = presentation(review.status)
  const Icon = content.icon

  return (
    <div
      className={`approval-review approval-review--${review.status}`}
      role={review.status === 'in_progress' ? 'status' : 'note'}
      aria-label={content.title}
    >
      <div className="approval-review__head">
        <Icon className={review.status === 'in_progress' ? 'spinner' : undefined} aria-hidden />
        <span className="approval-review__title">{content.title}</span>
        {review.riskLevel ? (
          <span className="approval-review__risk">{review.riskLevel} risk</span>
        ) : null}
      </div>
      <p className="approval-review__action">{review.description}</p>
      {review.rationale ? <p className="approval-review__rationale">{review.rationale}</p> : null}
    </div>
  )
}

function presentation(status: ApprovalReviewModel['status']) {
  switch (status) {
    case 'in_progress':
      return { title: 'Reviewing permission', icon: LoaderCircle }
    case 'approved':
      return { title: 'Permission approved', icon: ShieldCheck }
    case 'denied':
      return { title: 'Permission denied', icon: ShieldX }
    case 'timed_out':
      return { title: 'Review timed out', icon: CircleAlert }
    case 'aborted':
      return { title: 'Review aborted', icon: CircleAlert }
  }
}
