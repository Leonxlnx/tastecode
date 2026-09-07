import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'
import { z } from 'zod'

const ClaudeAccountSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().optional(),
  subscriptionType: z.string().optional(),
})

export type ClaudeAccountOptions = {
  run?: typeof runCli
}

export type ClaudeLogin = {
  loginId: string
  cancel: () => void
}

export async function claudeAccount(options: ClaudeAccountOptions = {}): Promise<Account> {
  const result = await (options.run ?? runCli)('claude', ['auth', 'status'])
  try {
    return parseClaudeAccount(result.stdout)
  } catch (cause) {
    if (result.code !== 0) throw new Error(`claude auth status exited with code ${result.code}`)
    throw cause
  }
}

export function parseClaudeAccount(output: string): Account {
  const result = ClaudeAccountSchema.safeParse(JSON.parse(output))
  if (!result.success) {
    throw new Error('Claude Code returned invalid auth status')
  }
  const value = result.data
  return {
    signedIn: value.loggedIn,
    ...(value.email ? { email: value.email } : {}),
    ...(value.subscriptionType ? { plan: value.subscriptionType } : {}),
  }
}

export function startClaudeLogin(
  onComplete: (result: { loginId: string; success: boolean; error: string | null }) => void,
): ClaudeLogin {
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
