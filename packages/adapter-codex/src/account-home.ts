import os from 'node:os'
import path from 'node:path'
import type { AccountHomeSource } from '@harness/proc/account-home'

/**
 * Codex keeps its settings, sign-in, sessions and logs in CODEX_HOME, which
 * is `~/.codex` unless set. Another account is another such folder. A new one
 * starts empty: the default folder's `config.toml` can hold MCP keys and
 * login pins (`forced_login_method`, `forced_chatgpt_workspace_id`) that
 * belong to the default account and would sign the new one in as it.
 */
export const CODEX_ACCOUNT_HOME: AccountHomeSource = {
  defaultHome: (environment = process.env) =>
    environment['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'),
  environment: (home) => ({ CODEX_HOME: home }),
  seedFiles: [],
  markers: ['config.toml', 'auth.json', 'sessions', 'history.jsonl'],
}

/** The variables a process for this account needs; none for the default account. */
export function codexAccountEnvironment(accountHome: string | undefined): NodeJS.ProcessEnv {
  return accountHome === undefined ? {} : CODEX_ACCOUNT_HOME.environment(accountHome)
}

/**
 * How much a plan holds against Plus, per window, for the account pool. From
 * OpenAI's published limits as of 2026-11-03: a Business or Team seat has the
 * same limits as Plus; Pro has no 5-hour window, and the $100 plan is 5x Plus
 * per week, the $200 plan 20x at its launch (new subscriptions may get less).
 * The labels are the ones the adapter's `planLabel` makes. Other plans have no known size.
 */
export function codexPlanWeights(
  plan: string | undefined,
): { session?: number; weekly?: number } | undefined {
  switch (plan) {
    case 'Plus':
    case 'Team':
    case 'Business':
      return { session: 1, weekly: 1 }
    case 'Pro x5':
      return { weekly: 5 }
    case 'Pro x20':
      return { weekly: 20 }
    default:
      return undefined
  }
}
