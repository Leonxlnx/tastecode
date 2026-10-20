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
