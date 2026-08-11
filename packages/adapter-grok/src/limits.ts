import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Weekly credit pool from the same billing endpoint the Grok CLI calls.
 * The CLI has no usage subcommand, so this reads ~/.grok/auth.json directly
 * (a map of account key -> entry, where the access token sits in `key`).
 * Refresh rotates the token, so a merge-save keeps other accounts intact.
 */

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const REFRESH_URL = 'https://auth.x.ai/oauth2/token'
const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const TIMEOUT_MS = 10_000

export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
}

type GrokAuthEntry = {
  key?: string
  refresh_token?: string
  refresh?: string
  expires_at?: string
  expires?: string
  oidc_client_id?: string
  [extra: string]: unknown
}

function authPath(): string {
  const grokHome = process.env['GROK_HOME']?.trim()
  return join(grokHome || join(homedir(), '.grok'), 'auth.json')
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function entryExpiryMs(entry: GrokAuthEntry): number | undefined {
  const iso = entry.expires_at ?? entry.expires
  if (typeof iso === 'string') {
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }
  return entry.key ? jwtExpiryMs(entry.key) : undefined
}

/** Pure mapping so the billing shape is testable without the network. */
export function mapGrokBilling(body: unknown): ProviderLimit[] {
  if (typeof body !== 'object' || body === null) return []
  const config = (body as Record<string, unknown>)['config']
  if (typeof config !== 'object' || config === null) return []
  const record = config as Record<string, unknown>
  const period = record['currentPeriod'] as Record<string, unknown> | undefined
  if (period?.['type'] !== 'USAGE_PERIOD_TYPE_WEEKLY') return []
  const rawPercent = record['creditUsagePercent'] ?? 0
  const numeric = typeof rawPercent === 'string' && rawPercent.trim() ? Number(rawPercent) : rawPercent
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return []
  const end = typeof period['end'] === 'string' ? Date.parse(period['end']) : Number.NaN
  return [
    {
      label: 'Weekly limit',
      usedPercent: Math.max(0, Math.min(100, numeric)),
      ...(Number.isFinite(end) ? { resetsAt: end } : {}),
    },
  ]
}

async function refreshEntry(
  accountKey: string,
  entry: GrokAuthEntry,
  all: Record<string, GrokAuthEntry>,
): Promise<string | undefined> {
  const refreshToken = entry.refresh_token ?? entry.refresh
  if (!refreshToken?.trim()) return undefined
  const clientId =
    entry.oidc_client_id ?? accountKey.split('::').at(-1)?.trim() ?? DEFAULT_CLIENT_ID
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId || DEFAULT_CLIENT_ID,
    refresh_token: refreshToken,
  })
  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) return undefined
  const json = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (typeof json.access_token !== 'string' || !json.access_token.trim()) return undefined
  const next: GrokAuthEntry = {
    ...entry,
    key: json.access_token,
    ...(json.refresh_token?.trim() ? { refresh_token: json.refresh_token } : {}),
  }
  delete next.expires_at
  delete next.expires
  if (Number.isFinite(json.expires_in) && (json.expires_in ?? 0) > 0) {
    next.expires_at = new Date(Date.now() + (json.expires_in as number) * 1000).toISOString()
  }
  // Merge into the existing map so other accounts are never dropped.
  const path = authPath()
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify({ ...all, [accountKey]: next }, null, 2), 'utf8')
  await rename(temp, path)
  return json.access_token
}

export async function grokLimits(): Promise<ProviderLimit[]> {
  try {
    let text: string
    try {
      text = await readFile(authPath(), 'utf8')
    } catch {
      return []
    }
    const all = JSON.parse(text) as Record<string, GrokAuthEntry>
    const entries = Object.entries(all).filter(
      ([, entry]) => typeof entry?.key === 'string' && Boolean(entry.key.trim()),
    )
    const picked = entries[0]
    if (!picked) return []
    const [accountKey, entry] = picked
    let token = entry.key as string
    const expiry = entryExpiryMs(entry)
    if (typeof expiry === 'number' && expiry - Date.now() <= REFRESH_MARGIN_MS) {
      token = (await refreshEntry(accountKey, entry, all)) ?? token
    }
    const response = await fetch(BILLING_URL, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        Accept: 'application/json',
        'User-Agent': 'personal-harness',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return []
    return mapGrokBilling(await response.json())
  } catch {
    return []
  }
}
