import { z } from 'zod'
import {
  claudeSdkSpawner,
  createClaudeUsageQuery,
  waitForAbort,
  type ClaudeSpawn,
  type ClaudeUsageQueryFactory,
} from './sdk-runtime.js'

export type ProviderLimit = {
  /** Stable within Claude, so a live window replaces exactly this row. */
  id?: string | undefined
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  windowMinutes?: number | undefined
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
 * The read asks Claude to skip the local transcript scan behind `/usage`'s
 * behaviors section, which plan limits never use. With the scan, Claude Code
 * 2.1.296 needed 17 to 60 seconds on about 10 GB of history and did not
 * answer within two minutes on 17 GB; without it the answer follows the CLI's
 * own start of a few seconds. An older CLI that predates the option ignores
 * it and scans, so on a long history it reports a timeout here rather than
 * keeping a heavy scan running.
 */
const TIMEOUT_MS = 20_000
const USAGE_REQUEST = { skipBehaviors: true } as const
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

const SESSION_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60

function windowRow(
  id: string,
  label: string,
  window: UsageWindow | null | undefined,
  windowMinutes?: number,
): ProviderLimit[] {
  if (!window || window.utilization === null) return []
  return [
    {
      id,
      label,
      usedPercent: window.utilization,
      ...(window.resets_at === null ? {} : { resetsAt: window.resets_at }),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
    },
  ]
}

function modelSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function mapClaudeUsage(value: unknown): ClaudeLimitSource {
  const result = UsageResponseSchema.safeParse(value)
  if (!result.success) throw new Error('Claude usage response was invalid.')
  const { rate_limits: rateLimits, rate_limits_available: available } = result.data
  if (!available || rateLimits === null) return { status: 'unavailable' }

  const limits = [
    ...windowRow('five_hour', 'Session', rateLimits.five_hour, SESSION_MINUTES),
    ...windowRow('seven_day', 'Weekly', rateLimits.seven_day, WEEK_MINUTES),
    ...windowRow('seven_day_sonnet', 'Sonnet weekly', rateLimits.seven_day_sonnet, WEEK_MINUTES),
    ...windowRow('seven_day_opus', 'Opus weekly', rateLimits.seven_day_opus, WEEK_MINUTES),
    ...windowRow(
      'seven_day_oauth_apps',
      'OAuth apps weekly',
      rateLimits.seven_day_oauth_apps,
      WEEK_MINUTES,
    ),
  ]
  const labels = new Set(limits.map((limit) => limit.label))
  for (const window of rateLimits.model_scoped ?? []) {
    const name = window.display_name.trim()
    if (!name) continue
    const label = `${name.charAt(0).toUpperCase()}${name.slice(1)} weekly`
    if (labels.has(label)) continue
    const slug = modelSlug(name)
    if (!slug) continue
    const [row] = windowRow(`model:${slug}`, label, window, WEEK_MINUTES)
    if (!row) continue
    limits.push(row)
    labels.add(label)
  }
  if (rateLimits.extra_usage?.is_enabled) {
    limits.push(
      ...windowRow('extra_usage', 'Extra usage', { ...rateLimits.extra_usage, resets_at: null }),
    )
  }
  return { status: 'ready', limits }
}

/**
 * The limit read starts a full CLI only to ask one control question, so it
 * turns off the startup work an interactive session does. All four names are
 * read by Claude Code 2.1.296; a CLI that does not know one ignores it.
 */
function limitReadEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  // claude.ai connectors are fetched outside the filesystem settings, so
  // `settingSources: []` and `strictMcpConfig` alone do not stop that request.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  // IDE detection walks the process list; on Windows every read would start a
  // `tasklist | findstr` process tree.
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = '0'
  // A read must never install an IDE extension.
  env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1'
  // An inherited value would make the CLI treat the read as an IDE terminal.
  delete env.FORCE_CODE_TERMINAL
  return env
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
      env: limitReadEnvironment(options.environment ?? process.env),
      spawnClaudeCodeProcess: claudeSdkSpawner(options.spawn),
    },
  })
  let usage: unknown
  try {
    usage = await withTimeout(
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(USAGE_REQUEST),
      options.timeoutMs ?? TIMEOUT_MS,
    )
  } catch (error) {
    // Only stable messages leave the adapter; the CLI's own text can carry
    // account details. A missed deadline keeps the TimeoutError name, so the
    // caller can stop repeating a read that never finishes.
    throw error instanceof TimeoutError ? error : new Error('Claude usage request failed.')
  } finally {
    abortController.abort()
    query.close()
  }
  return mapClaudeUsage(usage)
}

class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

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
