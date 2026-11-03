import os from 'node:os'
import path from 'node:path'
import type { AccountHomeSource } from '@harness/proc/account-home'

/**
 * Claude Code keeps its settings, sign-in, global config and transcripts in
 * CLAUDE_CONFIG_DIR, which is `~/.claude` unless set. Another account is
 * another such folder; HOME stays the user's own. A new folder starts empty:
 * the default folder's `settings.json` can hold an API key (`env`,
 * `apiKeyHelper`) or a login pin (`forceLoginOrgUUID`) that belongs to the
 * default account and would run the new one as it.
 */
export const CLAUDE_ACCOUNT_HOME: AccountHomeSource = {
  defaultHome: (environment = process.env) =>
    environment['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'),
  environment: (home) => ({ CLAUDE_CONFIG_DIR: home }),
  seedFiles: [],
  markers: ['.claude.json', 'projects', 'history.jsonl'],
}

/** The variables a process for this account needs; none for the default account. */
export function claudeAccountEnvironment(accountHome: string | undefined): NodeJS.ProcessEnv {
  return accountHome === undefined ? {} : CLAUDE_ACCOUNT_HOME.environment(accountHome)
}

/**
 * The complete environment for an account's process. The SDK hands this to
 * the CLI as it is, so the account's variables go on top of everything else;
 * the default account gets `base` unchanged.
 */
export function withClaudeAccount(
  base: NodeJS.ProcessEnv,
  accountHome: string | undefined,
): NodeJS.ProcessEnv {
  return accountHome === undefined ? base : { ...base, ...claudeAccountEnvironment(accountHome) }
}

/**
 * How much a plan holds against Pro, per window, for the account pool. From
 * Anthropic's published limits as of 2026-11-03: Max is 5x Pro; Ultra (older
 * CLIs still say "Max x20") is 10x Pro per week and has no 5-hour window;
 * Team Standard is 1.25x Pro per session, its weekly size is not published.
 * The labels are the ones `claudePlanLabel` makes. Other plans have no known size.
 */
export function claudePlanWeights(
  plan: string | undefined,
): { session?: number; weekly?: number } | undefined {
  switch (plan) {
    case 'Pro':
      return { session: 1, weekly: 1 }
    case 'Max':
    case 'Max x5':
      return { session: 5, weekly: 5 }
    case 'Max x20':
    case 'Ultra':
      return { weekly: 10 }
    case 'Team':
      return { session: 1.25 }
    default:
      return undefined
  }
}

/**
 * Whether a limit row is one of the account's overall windows, which the account pool
 * sums across accounts: the 5-hour session and the weekly limit over all models. The
 * model-scoped weekly limits (`seven_day_opus`, `seven_day_sonnet`, …) cover only part
 * of the plan and stay out of the pool.
 */
export function claudeOverallLimit(id: string): boolean {
  return id === 'five_hour' || id === 'seven_day'
}
