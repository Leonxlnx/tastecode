import type { Capabilities } from '@harness/contracts'

export const CODEX_CAPABILITIES: Capabilities = {
  steer: true,
  fork: true,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
  // Codex's catalog gives current models a 272K window, stretching to 872K on
  // the models that allow it. It compacts at 90% of the window unless told a
  // token count, and has no off switch.
  context: {
    windows: [272_000, 872_000],
    compaction: true,
    compactionOff: false,
    defaultCompactAt: 90,
  },
}
