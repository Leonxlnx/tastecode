import type { ProviderStatus } from '@harness/contracts'
import { runCli } from '@harness/proc'

type AuthStatus = ProviderStatus['auth']
type LoginStatusRunner = (
  command: string,
  args: string[],
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

/** A short CLI check avoids starting the much larger app-server during application startup. */
export async function codexLoginStatus(run: LoginStatusRunner = runCli): Promise<AuthStatus> {
  try {
    const result = await run('codex', ['login', 'status'])
    return parseCodexLoginStatus(`${result.stdout}\n${result.stderr ?? ''}`, result.code)
  } catch {
    return 'unknown'
  }
}
