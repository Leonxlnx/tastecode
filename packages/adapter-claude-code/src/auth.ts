import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'
import { z } from 'zod'

const ClaudeAccountSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().nullish(),
  subscriptionType: z.string().nullish(),
})

const ClaudeGlobalConfigSchema = z.object({
  oauthAccount: z
    .object({
      userRateLimitTier: z.string().nullish(),
      organizationRateLimitTier: z.string().nullish(),
    })
    .nullish(),
})

export type ClaudeAccountOptions = {
  run?: typeof runCli
  readRateLimitTier?: () => Promise<string | undefined>
}

export type ClaudeLogin = {
  loginId: string
  cancel: () => Promise<void>
}

export async function claudeAccount(options: ClaudeAccountOptions = {}): Promise<Account> {
  const result = await (options.run ?? runCli)('claude', ['auth', 'status'])
  let account: Account
  try {
    account = parseClaudeAccount(result.stdout)
  } catch (cause) {
    if (result.code !== 0) throw new Error(`claude auth status exited with code ${result.code}`)
    throw cause
  }
  if (!account.plan) return account
  const tier = await (options.readRateLimitTier ?? readClaudeRateLimitTier)()
  return { ...account, plan: claudePlanLabel(account.plan, tier) }
}

/**
 * `claude auth status` reports Max without its usage multiplier; the CLI keeps that in the
 * rate-limit tier of its global config (e.g. `default_claude_max_5x`).
 */
async function readClaudeRateLimitTier(): Promise<string | undefined> {
  const configDir = process.env['CLAUDE_CONFIG_DIR']
  const file = configDir
    ? path.join(configDir, '.claude.json')
    : path.join(homedir(), '.claude.json')
  try {
    const parsed = ClaudeGlobalConfigSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
    const account = parsed.success ? parsed.data.oauthAccount : undefined
    return account?.userRateLimitTier ?? account?.organizationRateLimitTier ?? undefined
  } catch {
    return undefined
  }
}

/** The vendor's plan ids are not display strings. */
export function claudePlanLabel(plan: string, tier?: string): string {
  const label = PLAN_LABELS.find(([id]) => id === plan)?.[1] ?? plan
  const multiplier = tier?.match(/_(\d+)x$/)?.[1]
  return multiplier ? `${label} x${multiplier}` : label
}

const PLAN_LABELS = [
  ['free', 'Free'],
  ['pro', 'Pro'],
  ['max', 'Max'],
  ['team', 'Team'],
  ['enterprise', 'Enterprise'],
] as const

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
