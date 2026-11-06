import type { Capabilities } from '@harness/contracts'

export const ANTIGRAVITY_CAPABILITIES: Capabilities = {
  // Print mode is one-shot: no steer, no fork, and permission prompts cannot
  // be answered mid-turn — the launch mode decides them instead.
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
  // agy's print mode takes text only, but its own file viewer opens images and
  // shows them to the model, so an attached image goes in as a path to open.
  imageFiles: true,
}
