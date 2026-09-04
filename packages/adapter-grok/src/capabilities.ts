import type { Capabilities } from '@harness/contracts'

export const GROK_CAPABILITIES: Capabilities = {
  // Print mode is one-shot: no steer, no fork, and permission prompts cannot
  // be answered mid-turn — the launch mode decides them instead.
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: false,
  images: true,
}
