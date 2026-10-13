import { z } from 'zod'
import {
  claudeSdkSpawner,
  createClaudeUsageQuery,
  waitForAbort,
  type ClaudeSpawn,
  type ClaudeUsageQueryFactory,
} from './sdk-runtime.js'

export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
}

export type ClaudeLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

export type ClaudeLimitSourceOptions = {
  createQuery?: ClaudeUsageQueryFactory | undefined
  environment?: NodeJS.ProcessEnv | undefined
  spawn?: ClaudeSpawn | undefined
  timeoutMs?: number | undefined
}

/**
 * Claude answers the usage request only after it has scanned the local
 * transcripts behind `/usage`. Captured against Claude Code 2.1.296 on a
 * machine with about 10 GB of history, the request itself took 17 to 60
 * seconds after a 2-second start, so a 10-second deadline reported a working
 * account as a failure. A slow answer is still an answer; only a stuck one is
 * cut off, with headroom because the scan grows with the history.
 */
const TIMEOUT_MS = 120_000
const TIMED_OUT = 'Claude usage request timed out.'
const PercentSchema = z
  .number()
  .finite()
  .transform((value) => Math.max(0, Math.min(100, value)))
const ResetTimestampSchema = z
  .string()
  .transform((value) => Date.parse(value))
  .pipe(z.number().finite())
const UsageWindowSchema = z.looseObject({
  utilization: PercentSchema.nullable(),
  resets_at: ResetTimestampSchema.nullable(),
})
const ModelWindowSchema = UsageWindowSchema.extend({
  display_name: z.string(),
})
const ExtraUsageSchema = z.looseObject({
  is_enabled: z.boolean(),
  utilization: PercentSchema.nullable(),
})
const RateLimitsSchema = z.looseObject({
  five_hour: UsageWindowSchema.nullish(),
  seven_day: UsageWindowSchema.nullish(),
  seven_day_oauth_apps: UsageWindowSchema.nullish(),
  seven_day_opus: UsageWindowSchema.nullish(),
  seven_day_sonnet: UsageWindowSchema.nullish(),
  model_scoped: z.array(ModelWindowSchema).optional(),
  extra_usage: ExtraUsageSchema.nullish(),
})
const UsageResponseSchema = z.looseObject({
  rate_limits_available: z.boolean(),
  rate_limits: RateLimitsSchema.nullable(),
})

type UsageWindow = z.infer<typeof UsageWindowSchema>

function windowRow(label: string, window: UsageWindow | null | undefined): ProviderLimit[] {
  if (!window || window.utilization === null) return []
  return [
    {
      label,
      usedPercent: window.utilization,
      ...(window.resets_at === null ? {} : { resetsAt: window.resets_at }),
    },
  ]
}

export function mapClaudeUsage(value: unknown): ClaudeLimitSource {
  const result = UsageResponseSchema.safeParse(value)
  if (!result.success) throw new Error('Claude usage response was invalid.')
  const { rate_limits: rateLimits, rate_limits_available: available } = result.data
  if (!available || rateLimits === null) return { status: 'unavailable' }

  const limits = [
    ...windowRow('Session', rateLimits.five_hour),
    ...windowRow('Weekly', rateLimits.seven_day),
    ...windowRow('Sonnet weekly', rateLimits.seven_day_sonnet),
    ...windowRow('Opus weekly', rateLimits.seven_day_opus),
    ...windowRow('OAuth apps weekly', rateLimits.seven_day_oauth_apps),
  ]
  const labels = new Set(limits.map((limit) => limit.label))
  for (const window of rateLimits.model_scoped ?? []) {
    const name = window.display_name.trim()
    if (!name) continue
    const label = `${name.charAt(0).toUpperCase()}${name.slice(1)} weekly`
    if (labels.has(label)) continue
    const [row] = windowRow(label, window)
    if (!row) continue
    limits.push(row)
    labels.add(label)
  }
  if (rateLimits.extra_usage?.is_enabled) {
    limits.push(...windowRow('Extra usage', { ...rateLimits.extra_usage, resets_at: null }))
  }
  return { status: 'ready', limits }
}

/** Read Claude's own structured /usage data without accessing its credentials. */
export async function claudeLimitSource(
  options: ClaudeLimitSourceOptions = {},
): Promise<ClaudeLimitSource> {
  const abortController = new AbortController()
  const query = (options.createQuery ?? createClaudeUsageQuery)({
    prompt: waitForAbort(abortController.signal),
    options: {
      pathToClaudeCodeExecutable: 'claude',
      cwd: process.cwd(),
      abortController,
      persistSession: false,
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      env: { ...(options.environment ?? process.env) },
      spawnClaudeCodeProcess: claudeSdkSpawner(options.spawn),
    },
  })
  let usage: unknown
  try {
    usage = await withTimeout(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      options.timeoutMs ?? TIMEOUT_MS,
    )
  } catch (error) {
    // Only stable messages leave the adapter; the CLI's own text can carry
    // account details.
    throw new Error(error instanceof TimeoutError ? TIMED_OUT : 'Claude usage request failed.')
  } finally {
    abortController.abort()
    query.close()
  }
  return mapClaudeUsage(usage)
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(TIMED_OUT)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
