import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { propertiesWhen } from './properties-when.js'

/**
 * Live subscription headroom from Anthropic's OAuth usage endpoint — the same
 * call Claude Code itself makes. The endpoint gates on the CLI's User-Agent,
 * so this impersonates it and will need bumping as the CLI versions.
 *
 * Departure from our usual posture: the CLI has no usage subcommand, so this
 * reads (and, when the token is stale, rotates) ~/.claude/.credentials.json
 * directly. The write-back preserves unknown sibling keys and is atomic —
 * dropping a rotated refresh token would sign the CLI out.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const USER_AGENT = 'claude-code/2.1.69'
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const TIMEOUT_MS = 10_000

export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
}

const LooseObjectSchema = z.looseObject({})
const BoundaryValueSchema = z.unknown()
const FiniteNumberSchema = z.number().finite()
const PercentSchema = z
  .union([FiniteNumberSchema, z.string().trim().min(1).transform(Number)])
  .pipe(FiniteNumberSchema)
  .transform((value) => Math.max(0, Math.min(100, value)))
const ResetTimestampSchema = z
  .string()
  .transform((value) => Date.parse(value))
  .pipe(FiniteNumberSchema)
const UsageWindowSchema = z.looseObject({
  utilization: PercentSchema,
  resets_at: ResetTimestampSchema.optional(),
})
const UsageLimitSchema = z.looseObject({
  kind: z.string(),
  percent: PercentSchema,
})
const ModelDisplayNameSchema = z.looseObject({
  scope: z.looseObject({ model: z.looseObject({ display_name: z.string() }) }),
})
const ClaudeOauthSchema = z.looseObject({
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().optional(),
  expiresAt: FiniteNumberSchema.optional(),
})
const ClaudeCredentialsSchema = z.looseObject({
  claudeAiOauth: ClaudeOauthSchema.optional(),
})
const RefreshResponseSchema = z.looseObject({
  access_token: z.string().trim().min(1),
  refresh_token: z.string().optional(),
  expires_in: FiniteNumberSchema.optional(),
})
const FileSystemErrorSchema = z.object({ code: z.string() })

type ClaudeOauth = z.infer<typeof ClaudeOauthSchema>
type ClaudeCredentials = z.infer<typeof ClaudeCredentialsSchema>
type BoundaryValue = z.input<typeof BoundaryValueSchema>

function credentialsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR']?.trim()
  return join(configDir || join(homedir(), '.claude'), '.credentials.json')
}

function windowRow(label: string, window: BoundaryValue): ProviderLimit[] {
  const result = UsageWindowSchema.safeParse(window)
  if (!result.success) return []
  const { utilization: usedPercent, resets_at: resetsAt } = result.data
  return [{ label, usedPercent, ...propertiesWhen(resetsAt !== undefined, () => ({ resetsAt })) }]
}

/** Pure mapping so the shape logic is testable without the network. */
export function mapClaudeUsage(body: BoundaryValue): ProviderLimit[] {
  const result = LooseObjectSchema.safeParse(body)
  if (!result.success) return []
  const record = result.data
  const rows = [
    ...windowRow('Session', record['five_hour']),
    ...windowRow('Weekly', record['seven_day']),
    ...windowRow('Sonnet weekly', record['seven_day_sonnet']),
    ...windowRow('Opus weekly', record['seven_day_opus']),
    ...windowRow('OAuth apps weekly', record['seven_day_oauth_apps']),
  ]
  // Newer responses carry per-model weekly windows in `limits[]` instead.
  const limits = z.array(UsageLimitSchema).safeParse(record['limits'])
  if (limits.success) {
    for (const limit of limits.data) {
      if (limit.kind !== 'weekly_scoped') continue
      const usedPercent = limit.percent
      const modelName = ModelDisplayNameSchema.safeParse(limit)
      const displayName = modelName.success ? modelName.data.scope.model.display_name.trim() : ''
      const name = displayName || 'Model'
      const label = `${name.charAt(0).toUpperCase()}${name.slice(1)} weekly`
      const reset = ResetTimestampSchema.safeParse(limit['resets_at'])
      const resetsAt = reset.success ? reset.data : undefined
      if (!rows.some((row) => row.label === label)) {
        rows.push({
          label,
          usedPercent,
          ...propertiesWhen(!(resetsAt === undefined), () => ({ resetsAt })),
        })
      }
    }
  }
  return rows
}

async function readOauth(): Promise<{ oauth: ClaudeOauth; raw: ClaudeCredentials } | undefined> {
  let text: string
  try {
    text = await readFile(credentialsPath(), 'utf8')
  } catch (cause) {
    const error = FileSystemErrorSchema.safeParse(cause)
    if (error.success && error.data.code === 'ENOENT') return undefined
    throw new Error('Claude credentials could not be read.')
  }
  let parsed: BoundaryValue
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Claude credentials could not be parsed.')
  }
  const result = ClaudeCredentialsSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error('Claude credentials could not be parsed.')
  }
  const raw = result.data
  if (!raw.claudeAiOauth) return undefined
  return { oauth: raw.claudeAiOauth, raw }
}

async function refreshAccessToken(
  oauth: ClaudeOauth,
  raw: ClaudeCredentials,
): Promise<string | undefined> {
  if (!oauth.refreshToken?.trim()) return undefined
  let response: Response
  try {
    response = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLIENT_ID,
        scope:
          'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Claude credential refresh request failed.')
  }
  if (!response.ok) {
    throw new Error(`Claude credential refresh failed (HTTP ${response.status})`)
  }
  let responseBody: BoundaryValue
  try {
    responseBody = await response.json()
  } catch {
    throw new Error('Claude credential refresh response was invalid.')
  }
  const result = RefreshResponseSchema.safeParse(responseBody)
  if (!result.success) {
    throw new Error('Claude credential refresh response was invalid.')
  }
  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  } = result.data
  const next: ClaudeOauth = {
    ...oauth,
    accessToken,
  }
  if (refreshToken?.trim()) next.refreshToken = refreshToken
  delete next.expiresAt
  if (expiresIn !== undefined && expiresIn > 0) {
    next.expiresAt = Date.now() + expiresIn * 1000
  }
  // The refresh token rotates: losing the new one signs the CLI out, so the
  // write must land (atomically) before the new access token is used.
  const path = credentialsPath()
  const temp = `${path}.tmp-${process.pid}`
  try {
    await writeFile(temp, JSON.stringify({ ...raw, claudeAiOauth: next }, null, 2), 'utf8')
    await rename(temp, path)
  } catch {
    await rm(temp, { force: true }).catch(() => undefined)
    throw new Error('Claude credentials could not be updated.')
  }
  return accessToken
}

export type ClaudeLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

const CLAUDE_USAGE_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'seven_day_oauth_apps',
] as const

function isUsageWindow(value: BoundaryValue): boolean {
  return value === null || UsageWindowSchema.safeParse(value).success
}

function isClaudeUsageBody(value: BoundaryValue): boolean {
  const result = LooseObjectSchema.safeParse(value)
  if (!result.success) return false
  const body = result.data
  let known = false
  for (const key of CLAUDE_USAGE_WINDOWS) {
    if (!Object.hasOwn(body, key)) continue
    known = true
    if (!isUsageWindow(body[key])) return false
  }
  if (Object.hasOwn(body, 'limits')) {
    known = true
    const limits = body['limits']
    if (limits !== null && !z.array(UsageLimitSchema).safeParse(limits).success) return false
  }
  if (Object.hasOwn(body, 'extra_usage')) {
    known = true
    if (body['extra_usage'] !== null && !LooseObjectSchema.safeParse(body['extra_usage']).success)
      return false
  }
  return known
}

export async function claudeLimitSource(): Promise<ClaudeLimitSource> {
  const stored = await readOauth()
  if (!stored) return { status: 'unavailable' }
  let token = stored.oauth.accessToken
  const expiresAt = stored.oauth.expiresAt
  if (expiresAt !== undefined && expiresAt - Date.now() <= REFRESH_MARGIN_MS) {
    token = (await refreshAccessToken(stored.oauth, stored.raw)) ?? token
  }
  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Claude usage request failed.')
  }
  if (!response.ok) throw new Error(`Claude usage request failed (HTTP ${response.status})`)
  let body: BoundaryValue
  try {
    body = await response.json()
  } catch {
    throw new Error('Claude usage response was invalid.')
  }
  if (!isClaudeUsageBody(body)) throw new Error('Claude usage response was invalid.')
  return { status: 'ready', limits: mapClaudeUsage(body) }
}

/** Compatibility view while the orchestrator migrates to the richer source state. */
export async function claudeLimits(): Promise<ProviderLimit[]> {
  const source = await claudeLimitSource()
  return source.status === 'ready' ? source.limits : []
}
