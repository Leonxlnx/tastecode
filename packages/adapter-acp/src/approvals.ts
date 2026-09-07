import type { ApprovalDecision } from '@harness/contracts'
import type { PermissionOptionKind, RequestPermissionParams } from './protocol.js'

/**
 * Choosing which option to send back when the user answers a permission
 * request.
 *
 * This is the highest-consequence mapping in the adapter: it converts a human
 * "no" into a wire value, and getting it wrong authorises something nobody
 * agreed to. It is a pure function so it can be tested directly, and it never
 * crosses from allow to reject or back.
 */

export type PermissionOption = NonNullable<RequestPermissionParams['options']>[number]

const DECISION_TO_KIND = {
  approve: 'allow_once',
  'approve-session': 'allow_always',
  deny: 'reject_once',
  abort: 'reject_once',
} satisfies Record<ApprovalDecision, PermissionOptionKind>

export function optionFor(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): string | undefined {
  const wanted = DECISION_TO_KIND[decision]

  const exact = options.find((option) => option.kind === wanted)
  if (exact?.optionId) return exact.optionId

  // Agents are not required to offer every kind. Fall back only within the
  // same direction: a missing "always" must never become a rejection, and a
  // missing "reject once" must never become an approval.
  const prefix = wanted.startsWith('allow') ? 'allow' : 'reject'
  const sameDirection = options.find(
    (option) => option.kind?.startsWith(prefix) && option.optionId !== undefined,
  )
  return sameDirection?.optionId
}
