import type { Capabilities } from '@harness/contracts'

export const OPENCODE_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  // opencode's `question` tool, answered through its v1 question routes.
  userInput: true,
  images: true,
}
