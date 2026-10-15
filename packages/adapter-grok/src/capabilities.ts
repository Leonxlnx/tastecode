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
  // Every Grok model reports a 256K window and an 80% compaction point. The
  // 500K variant is chosen only inside Grok's own TUI, so it is not offered here.
  context: { windows: [256_000], compaction: true, compactionOff: false, defaultCompactAt: 80 },
}
