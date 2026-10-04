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

  // A session grant may be narrowed to one use, never the other way round.
  if (decision === 'approve-session') {
    return options.find((option) => option.kind === 'allow_once' && option.optionId)?.optionId
  }
  return undefined
}
