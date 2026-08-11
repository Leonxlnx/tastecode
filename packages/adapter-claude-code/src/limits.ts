import { readFile, rename, writeFile } from 'node:fs/promises'
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

function clampPercent(value: unknown): number | undefined {
  const numeric = typeof value === 'string' ? Number(value) : value
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
      const name = typeof model?.['display_name'] === 'string' ? model['display_name'] : 'Model'
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
  } catch {
    return undefined
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const oauth = raw['claudeAiOauth'] as ClaudeOauth | undefined
    if (!oauth || typeof oauth.accessToken !== 'string') return undefined
    return { oauth, raw }
  } catch {
    return undefined
  }
}

async function refreshAccessToken(
  oauth: ClaudeOauth,
  raw: Record<string, unknown>,
): Promise<string | undefined> {
  if (!oauth.refreshToken) return undefined
  const response = await fetch(REFRESH_URL, {
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
  if (!response.ok) return undefined
  const body = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (typeof body.access_token !== 'string') return undefined
  const next: ClaudeOauth = {
    ...oauth,
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === 'number'
      ? { expiresAt: Date.now() + body.expires_in * 1000 }
      : {}),
  }
  // The refresh token rotates: losing the new one signs the CLI out, so the
  // write must land (atomically) before the new access token is used.
  const path = credentialsPath()
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify({ ...raw, claudeAiOauth: next }, null, 2), 'utf8')
  await rename(temp, path)
  return body.access_token
}

export async function claudeLimits(): Promise<ProviderLimit[]> {
  try {
    const stored = await readOauth()
    if (!stored) return []
    let token = stored.oauth.accessToken
    const expiresAt = stored.oauth.expiresAt
    if (typeof expiresAt === 'number' && expiresAt - Date.now() <= REFRESH_MARGIN_MS) {
      token = (await refreshAccessToken(stored.oauth, stored.raw)) ?? token
    }
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return []
    return mapClaudeUsage(await response.json())
  } catch {
    return []
  }
}
