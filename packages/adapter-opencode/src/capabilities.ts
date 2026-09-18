import type { Capabilities } from '@harness/contracts'

/** OpenCode runs its own agent loop and tool permissions behind its server;
 *  it can be interrupted and can surface permission prompts, but turns cannot
 *  be steered or forked from the client. */
export const OPENCODE_CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: false,
}
