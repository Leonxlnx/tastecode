import os from 'node:os'
import path from 'node:path'
import type { AccountHomeSource } from '@harness/proc/account-home'

/**
 * Codex keeps its settings, sign-in, sessions and logs in CODEX_HOME, which
 * is `~/.codex` unless set. Another account is another such folder. A new one
 * starts with the default folder's `config.toml` (models, MCP servers,
 * approvals); the sign-in stays where Codex wrote it.
 */
export const CODEX_ACCOUNT_HOME: AccountHomeSource = {
  defaultHome: (environment = process.env) =>
    environment['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'),
  environment: (home) => ({ CODEX_HOME: home }),
  seedFiles: ['config.toml'],
}

/** The variables a process for this account needs; none for the default account. */
export function codexAccountEnvironment(accountHome: string | undefined): NodeJS.ProcessEnv {
  return accountHome === undefined ? {} : CODEX_ACCOUNT_HOME.environment(accountHome)
}
