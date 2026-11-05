import type { Capabilities } from '@harness/contracts'

export const CURSOR_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  // Without --force the CLI refuses a folder it does not trust instead of asking.
  askFirst: false,
  images: true,
}
