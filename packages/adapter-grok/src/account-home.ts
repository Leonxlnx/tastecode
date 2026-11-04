import os from 'node:os'
import path from 'node:path'
import type { AccountHomeSource } from '@harness/proc/account-home'

/**
 * Grok keeps its sign-in (`auth.json`), settings and sessions in GROK_HOME,
 * which is `~/.grok` unless set; its own documentation tells multi-user hosts to
 * keep `$GROK_HOME` private. Another account is another such folder, while the
 * CLI itself still runs from where it is installed. A new folder starts empty:
 * the default folder's `config.toml` can hold an API key of the default account.
 */
export const GROK_ACCOUNT_HOME: AccountHomeSource = {
  defaultHome: (environment = process.env) =>
    environment['GROK_HOME'] ?? path.join(os.homedir(), '.grok'),
  environment: (home) => ({ GROK_HOME: home }),
  seedFiles: [],
  markers: ['auth.json', 'config.toml', 'sessions'],
}

/** The variables a process for this account needs; none for the default account. */
export function grokAccountEnvironment(accountHome: string | undefined): Record<string, string> {
  return accountHome === undefined ? {} : { GROK_HOME: accountHome }
}
