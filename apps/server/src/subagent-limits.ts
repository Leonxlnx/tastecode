/**
 * How far sub-agents may go. One place, so a change to a limit is one diff.
 *
 * Depth is one level: a sub-agent never gets the tools to start its own.
 */
export const SUBAGENT_LIMITS = {
  /** Sub-agents of one chat running at the same time. */
  runningPerChat: 4,
  /** Sub-agents one turn of a chat may start. */
  startedPerTurn: 12,
  /** Sub-agents running across the whole app. */
  runningInApp: 8,
  /** Characters a task may have. */
  taskCharacters: 32_000,
  /**
   * The longest single wait. Engines end an MCP call that runs too long
   * (Codex after 60 s by default), so a longer wait is the caller's loop.
   */
  waitSeconds: 50,
  /** Characters of a sub-agent's final message handed back; the start and end are kept. */
  resultCharacters: 20_000,
} as const
