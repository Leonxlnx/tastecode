import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'
import { z } from 'zod'
import { claudeAccountEnvironment } from './account-home.js'

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
  /** Ask as the account in this config folder. Absent: the default account. */
  accountHome?: string | undefined
}

/** How a CLI command for an account gets that account's folder; nothing for the default one. */
function accountRunOptions(accountHome: string | undefined): [] | [{ env: NodeJS.ProcessEnv }] {
  return accountHome === undefined ? [] : [{ env: claudeAccountEnvironment(accountHome) }]
}

export type ClaudeLogin = {
  loginId: string
  cancel: () => Promise<void>
}

/**
 * `claude auth status` starts the full native CLI. It answers in 1-4 s on an
 * idle machine but took 11.5 s on a real profile under load, so the generic
 * 5 s limit reported a signed-in account as unavailable.
 */
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 20_000

export async function claudeAccount(options: ClaudeAccountOptions = {}): Promise<Account> {
  const result = await (options.run ?? runCli)(
    'claude',
    ['auth', 'status'],
    CLAUDE_AUTH_STATUS_TIMEOUT_MS,
    ...accountRunOptions(options.accountHome),
  )
  let account: Account
  try {
    account = parseClaudeAccount(result.stdout)
  } catch (cause) {
    if (result.code !== 0) throw new Error(`claude auth status exited with code ${result.code}`)
    throw cause
  }
  if (!account.plan) return account
  const tier = await (options.readRateLimitTier
    ? options.readRateLimitTier()
    : readClaudeRateLimitTier(options.accountHome))
  return { ...account, plan: claudePlanLabel(account.plan, tier) }
}

/**
 * `claude auth status` reports Max without its usage multiplier; the CLI keeps that in the
 * rate-limit tier of its global config (e.g. `default_claude_max_5x`), which sits in the
 * account's config folder when one is set.
 */
async function readClaudeRateLimitTier(accountHome?: string): Promise<string | undefined> {
  const configDir = accountHome ?? process.env['CLAUDE_CONFIG_DIR']
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

/** Claude's own sign-in flow; with `accountHome`, it signs that account's folder in. */
export function startClaudeLogin(
  onComplete: (result: { loginId: string; success: boolean; error: string | null }) => void,
  options: { accountHome?: string | undefined } = {},
): ClaudeLogin {
  const loginId = crypto.randomUUID()
  const child = spawnCli('claude', ['auth', 'login'], ...accountRunOptions(options.accountHome))
  // Nothing reads these pipes; an undrained pipe blocks the CLI once it has
  // written a buffer's worth (sign-in URLs, verbose retries) and the sign-in
  // would hang forever.
  child.stdout.resume()
  child.stderr.resume()
  let settled = false
  const finish = (success: boolean, error: string | null) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    void killTree(child).then(
      () => onComplete({ loginId, success, error }),
      () => onComplete({ loginId, success: false, error: 'Claude Code sign-in could not stop.' }),
    )
  }
  const deadline = setTimeout(
    () => {
      finish(false, 'Claude Code sign-in timed out.')
    },
    10 * 60 * 1000,
  )
  deadline.unref?.()
  child.on('error', () => finish(false, 'Claude Code could not start its sign-in flow.'))
  child.on('exit', (code) => finish(code === 0, code === 0 ? null : 'Claude Code sign-in failed.'))
  return { loginId, cancel: () => killTree(child) }
}

/** Signs out the default account, or with `accountHome` that account's folder only. */
export async function signOutClaude(
  options: { accountHome?: string | undefined; run?: typeof runCli } = {},
): Promise<void> {
  const result = await (options.run ?? runCli)(
    'claude',
    ['auth', 'logout'],
    15_000,
    ...accountRunOptions(options.accountHome),
  )
  if (result.code !== 0) throw new Error('Claude Code could not sign out.')
}
