import type { Account } from '@harness/contracts'
import { killTree, runCli, spawnCli } from '@harness/proc'
import { z } from 'zod'
import {
  claudeSdkSpawner,
  createClaudeQuery,
  waitForAbort,
  type ClaudeQueryFactory,
  type ClaudeSpawn,
} from './sdk-runtime.js'
import { propertiesWhen } from './properties-when.js'

const ClaudeAccountSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().optional(),
  subscriptionType: z.string().optional(),
})

export type ClaudeAccountOptions = {
  createQuery?: ClaudeQueryFactory
  spawn?: ClaudeSpawn
  run?: typeof runCli
}

export type ClaudeLogin = {
  loginId: string
  cancel: () => void
}

export async function claudeAccount(options: ClaudeAccountOptions = {}): Promise<Account> {
  const result = await (options.run ?? runCli)('claude', ['auth', 'status'])
  try {
    const account = parseClaudeAccount(result.stdout)
    if (!account.signedIn || (account.email && account.plan)) return account
    const sdkAccount = await probeClaudeAccount(options).catch(() => undefined)
    return sdkAccount ? { ...account, ...sdkAccount, signedIn: true } : account
  } catch (cause) {
    if (result.code !== 0) throw new Error(`claude auth status exited with code ${result.code}`)
    throw cause
  }
}

/**
 * Read the SDK initialization account without yielding a prompt. This fills
 * the email/plan fields older `claude auth status` versions omit and never
 * starts an Anthropic API request.
 */
export async function probeClaudeAccount(options: ClaudeAccountOptions = {}): Promise<Account> {
  const abort = new AbortController()
  const query = (options.createQuery ?? createClaudeQuery)({
    prompt: waitForAbort(abort.signal),
    options: {
      pathToClaudeCodeExecutable: 'claude',
      env: { ...process.env },
      spawnClaudeCodeProcess: claudeSdkSpawner(options.spawn),
      abortController: abort,
      persistSession: false,
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
    },
  })
  try {
    const initialization = await withTimeout(
      query.initializationResult(),
      10_000,
      'Claude account discovery timed out',
    )
    const account = initialization.account
    const signedIn = Boolean(
      account?.email || account?.subscriptionType || account?.tokenSource || account?.apiKeySource,
    )
    return {
      signedIn,
      ...propertiesWhen(account?.email, (includedValue) => ({ email: includedValue })),
      ...propertiesWhen(account?.subscriptionType, (includedValue) => ({ plan: includedValue })),
    }
  } finally {
    abort.abort()
    query.close()
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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
    ...propertiesWhen(value.email, (email) => ({ email })),
    ...propertiesWhen(value.subscriptionType, (plan) => ({ plan })),
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
