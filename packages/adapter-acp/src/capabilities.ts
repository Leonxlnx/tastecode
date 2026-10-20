import type { Capabilities } from '@harness/contracts'

/**
 * What every ACP agent offers through this adapter. ACP has no steer or
 * fork; it has cancellation and thinking, and permission requests are core
 * to it. Image input is negotiated per agent at `initialize`, so the listing
 * claims none and a running session reports what its agent accepted.
 */
export const ACP_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: false,
}
