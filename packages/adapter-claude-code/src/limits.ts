import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

type ClaudeOauth = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  [key: string]: unknown
}

function credentialsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR']?.trim()
  return join(configDir || join(homedir(), '.claude'), '.credentials.json')
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function clampPercent(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return undefined
  return Math.max(0, Math.min(100, numeric))
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function windowRow(label: string, window: unknown): ProviderLimit[] {
  if (typeof window !== 'object' || window === null) return []
  const record = window as Record<string, unknown>
  const usedPercent = clampPercent(record['utilization'])
  if (usedPercent === undefined) return []
  const resetsAt = parseResetsAt(record['resets_at'])
  return [{ label, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) }]
}

/** Pure mapping so the shape logic is testable without the network. */
export function mapClaudeUsage(body: unknown): ProviderLimit[] {
  if (typeof body !== 'object' || body === null) return []
  const record = body as Record<string, unknown>
  const rows = [
    ...windowRow('Session', record['five_hour']),
    ...windowRow('Weekly', record['seven_day']),
    ...windowRow('Sonnet weekly', record['seven_day_sonnet']),
    ...windowRow('Opus weekly', record['seven_day_opus']),
    ...windowRow('OAuth apps weekly', record['seven_day_oauth_apps']),
  ]
  // Newer responses carry per-model weekly windows in `limits[]` instead.
  if (Array.isArray(record['limits'])) {
    for (const entry of record['limits'] as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const limit = entry as Record<string, unknown>
      if (limit['kind'] !== 'weekly_scoped') continue
      const usedPercent = clampPercent(limit['percent'])
      if (usedPercent === undefined) continue
      const scope = limit['scope'] as Record<string, unknown> | undefined
      const model = scope?.['model'] as Record<string, unknown> | undefined
      const displayName = model?.['display_name']
      const name = typeof displayName === 'string' && displayName.trim() ? displayName : 'Model'
      const label = `${name.charAt(0).toUpperCase()}${name.slice(1)} weekly`
      const resetsAt = parseResetsAt(limit['resets_at'])
      if (!rows.some((row) => row.label === label)) {
        rows.push({ label, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) })
      }
    }
  }
  return rows
}

async function readOauth(): Promise<
  { oauth: ClaudeOauth; raw: Record<string, unknown> } | undefined
> {
  let text: string
  try {
    text = await readFile(credentialsPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Claude credentials could not be read.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Claude credentials could not be parsed.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Claude credentials could not be parsed.')
  }
  const raw = parsed as Record<string, unknown>
  const candidate = raw['claudeAiOauth']
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('Claude credentials could not be parsed.')
  }
  const oauth = candidate as ClaudeOauth
  if (typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) {
    throw new Error('Claude credentials could not be parsed.')
  }
  if (oauth.refreshToken !== undefined && typeof oauth.refreshToken !== 'string') {
    throw new Error('Claude credentials could not be parsed.')
  }
  if (
    oauth.expiresAt !== undefined &&
    (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt))
  ) {
    throw new Error('Claude credentials could not be parsed.')
  }
  return { oauth, raw }
}

async function refreshAccessToken(
  oauth: ClaudeOauth,
  raw: Record<string, unknown>,
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
  let body: Record<string, unknown> | undefined
  try {
    body = object(await response.json())
  } catch {
    throw new Error('Claude credential refresh response was invalid.')
  }
  const accessToken = body?.['access_token']
  const refreshToken = body?.['refresh_token']
  const expiresIn = body?.['expires_in']
  if (
    typeof accessToken !== 'string' ||
    !accessToken.trim() ||
    (refreshToken !== undefined && typeof refreshToken !== 'string') ||
    (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)))
  ) {
    throw new Error('Claude credential refresh response was invalid.')
  }
  const next: ClaudeOauth = {
    ...oauth,
    accessToken,
    ...(typeof refreshToken === 'string' && refreshToken.trim() ? { refreshToken } : {}),
  }
  delete next.expiresAt
  if (typeof expiresIn === 'number' && expiresIn > 0) {
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

function isUsageWindow(value: unknown): boolean {
  if (value === null) return true
  const window = object(value)
  if (!window || clampPercent(window['utilization']) === undefined) return false
  const reset = window['resets_at']
  return reset === undefined || reset === null || parseResetsAt(reset) !== undefined
}

function isClaudeUsageBody(value: unknown): value is Record<string, unknown> {
  const body = object(value)
  if (!body) return false
  let known = false
  for (const key of CLAUDE_USAGE_WINDOWS) {
    if (!Object.hasOwn(body, key)) continue
    known = true
    if (!isUsageWindow(body[key])) return false
  }
  if (Object.hasOwn(body, 'limits')) {
    known = true
    const limits = body['limits']
    if (
      limits !== null &&
      (!Array.isArray(limits) ||
        !limits.every((entry) => {
          const limit = object(entry)
          return Boolean(
            limit &&
            typeof limit['kind'] === 'string' &&
            clampPercent(limit['percent']) !== undefined,
          )
        }))
    )
      return false
  }
  if (Object.hasOwn(body, 'extra_usage')) {
    known = true
    if (body['extra_usage'] !== null && !object(body['extra_usage'])) return false
  }
  return known
}

export async function claudeLimitSource(): Promise<ClaudeLimitSource> {
  const stored = await readOauth()
  if (!stored) return { status: 'unavailable' }
  let token = stored.oauth.accessToken
  const expiresAt = stored.oauth.expiresAt
  if (typeof expiresAt === 'number' && expiresAt - Date.now() <= REFRESH_MARGIN_MS) {
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
  let body: unknown
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
