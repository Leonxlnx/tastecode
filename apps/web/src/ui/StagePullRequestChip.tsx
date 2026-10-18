import type {
  CheckoutPullRequest,
  PullRequestChecksSummary,
  PullRequestTarget,
} from '@harness/contracts'
import {
  IconCircleCheck as CheckCircle,
  IconCircleX as XCircle,
  IconGitMerge as GitMerge,
  IconGitPullRequest as GitPullRequest,
  IconGitPullRequestClosed as GitPullRequestClosed,
  IconGitPullRequestDraft as GitPullRequestDraft,
  IconLoader2 as LoaderCircle,
  type TablerIcon,
} from '@tabler/icons-react'

type ChipPart = { label: string; icon: TablerIcon }
type ChipState = ChipPart & { tone: 'open' | 'draft' | 'merged' | 'closed' }

const CHECKS = {
  passing: { label: 'Checks passing', icon: CheckCircle },
  failing: { label: 'Checks failing', icon: XCircle },
  pending: { label: 'Checks running', icon: LoaderCircle },
  none: undefined,
} satisfies Record<PullRequestChecksSummary, ChipPart | undefined>

const STATES = {
  open: { label: 'Open', tone: 'open', icon: GitPullRequest },
  draft: { label: 'Draft', tone: 'draft', icon: GitPullRequestDraft },
  merged: { label: 'Merged', tone: 'merged', icon: GitMerge },
  closed: { label: 'Closed', tone: 'closed', icon: GitPullRequestClosed },
} satisfies Record<ChipState['tone'], ChipState>

/** The chat checkout's pull request: number, state and, while open, its checks. */
export function StagePullRequestChip(props: {
  pullRequest: CheckoutPullRequest
  onOpen: (target: PullRequestTarget) => void
}) {
  const { pullRequest } = props
  const state =
    pullRequest.state === 'MERGED'
      ? STATES.merged
      : pullRequest.state === 'CLOSED'
        ? STATES.closed
        : pullRequest.isDraft
          ? STATES.draft
          : STATES.open
  const StateIcon = state.icon
  // Checks of a merged or closed pull request no longer decide anything.
  const checks =
    pullRequest.state === 'OPEN' && pullRequest.checks ? CHECKS[pullRequest.checks] : undefined
  const ChecksIcon = checks?.icon
  const summary = checks ? `${state.label}, ${checks.label}` : state.label

  return (
    <button
      type="button"
      className={`stagehead__pr is-${state.tone}`}
      aria-label={`Pull request #${pullRequest.number}: ${summary}. Show in Pull requests`}
      title={`${pullRequest.title}\n#${pullRequest.number} · ${summary}`}
      onClick={() =>
        props.onOpen({ repository: pullRequest.repository, number: pullRequest.number })
      }
    >
      <StateIcon className="stagehead__pr-state" size={14} aria-hidden />
      <span className="stagehead__pr-number">#{pullRequest.number}</span>
      <span className="stagehead__pr-label">{state.label}</span>
      {ChecksIcon ? (
        <ChecksIcon
          className={`stagehead__pr-checks is-${pullRequest.checks}`}
          size={13}
          aria-hidden
        />
      ) : null}
    </button>
  )
}
