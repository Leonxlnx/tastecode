import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'

export async function claudeAccount(): Promise<Account> {
  const result = await runCli('claude', ['auth', 'status'])
  try {
    return parseClaudeAccount(result.stdout)
  } catch (cause) {
    if (result.code !== 0) throw new Error(`claude auth status exited with code ${result.code}`)
    throw cause
  }
}

export function parseClaudeAccount(output: string): Account {
  const value = JSON.parse(output) as Record<string, unknown>
  if (typeof value.loggedIn !== 'boolean')
    throw new Error('Claude Code returned invalid auth status')
  return {
    signedIn: value.loggedIn,
    ...(typeof value.email === 'string' ? { email: value.email } : {}),
    ...(typeof value.subscriptionType === 'string' ? { plan: value.subscriptionType } : {}),
  }
}

export function startClaudeLogin(
  onComplete: (result: { loginId: string; success: boolean; error: string | null }) => void,
): { loginId: string; cancel: () => void } {
  const loginId = crypto.randomUUID()
  const child = spawnCli('claude', ['auth', 'login'])
  let settled = false
  const finish = (success: boolean, error: string | null) => {
    if (settled) return
    settled = true
    onComplete({ loginId, success, error })
  }
  child.on('error', () => finish(false, 'Claude Code could not start its sign-in flow.'))
  child.on('exit', (code) => finish(code === 0, code === 0 ? null : 'Claude Code sign-in failed.'))
  return { loginId, cancel: () => killTree(child) }
}

export async function signOutClaude(): Promise<void> {
  const result = await runCli('claude', ['auth', 'logout'], 15_000)
  if (result.code !== 0) throw new Error('Claude Code could not sign out.')
}
