import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalMode } from '@harness/contracts'

/** The Claude Code permission mode each access level runs with. */
export const PERMISSION_MODE = {
  ask: 'default',
  auto: 'acceptEdits',
  'auto-review': 'auto',
  full: 'bypassPermissions',
} satisfies Record<ApprovalMode, PermissionMode>

const APPROVAL = new Map<unknown, ApprovalMode>(
  Object.entries(PERMISSION_MODE).map(([approval, mode]) => [mode, approval as ApprovalMode]),
)

/** The access level a saved permission mode stands for; plan mode and unknown ones have none. */
export function approvalFor(mode: unknown): ApprovalMode | undefined {
  return APPROVAL.get(mode)
}
