import type { ProviderStatus } from '@harness/contracts'
import { runCli } from '@harness/proc/cli'
import { codexAccountEnvironment } from './account-home.js'

type AuthStatus = ProviderStatus['auth']
type LoginStatusRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ code: number | null; stdout: string; stderr?: string | undefined }>

/** Parse only Codex's public login-status output; credential files stay provider-owned. */
export function parseCodexLoginStatus(stdout: string, code: number | null): AuthStatus {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes('Not logged in')) return 'unauthenticated'
  if (code === 0 && lines.some((line) => line.startsWith('Logged in using '))) {
    return 'authenticated'
  }
  return 'unknown'
}

/**
 * A short CLI check avoids starting the much larger app-server during application startup.
 * `accountHome` asks as that account; absent, as the default one.
 */
export async function codexLoginStatus(
  run: LoginStatusRunner = runCli,
  options: { accountHome?: string | undefined } = {},
): Promise<AuthStatus> {
  try {
    const result =
      options.accountHome === undefined
        ? await run('codex', ['login', 'status'])
        : await run('codex', ['login', 'status'], undefined, {
            env: codexAccountEnvironment(options.accountHome),
          })
    return parseCodexLoginStatus(`${result.stdout}\n${result.stderr ?? ''}`, result.code)
  } catch {
    return 'unknown'
  }
}
