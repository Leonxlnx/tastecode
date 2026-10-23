import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalMode } from '@harness/contracts'

/** The Claude Code permission mode each access level runs with. */
export const PERMISSION_MODE = {
  ask: 'default',
  auto: 'acceptEdits',
  'auto-review': 'auto',
  full: 'bypassPermissions',
} satisfies Record<ApprovalMode, PermissionMode>
