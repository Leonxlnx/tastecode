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
  // A subagent's thread streams on the chat's connection, so its tool calls and tokens
  // count up while it runs.
  subagents: 'progress',
  // Codex's catalog gives current models a 272K window, stretching to 872K on
  // the models that allow it. It compacts at 90% of the window unless told a
  // token count, clamps a later count back to 90%, and has no off switch.
  context: {
    windows: [272_000, 872_000],
    compaction: true,
    compactionOff: false,
    defaultCompactAt: 90,
    latestCompactAt: 90,
  },
}
