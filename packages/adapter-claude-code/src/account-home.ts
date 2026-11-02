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
