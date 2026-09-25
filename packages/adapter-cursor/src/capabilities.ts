import type { Capabilities } from '@harness/contracts'

export const CURSOR_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}
