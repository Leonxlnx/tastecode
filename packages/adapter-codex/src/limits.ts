import {
  CodexResetCreditSchema,
  type CodexRateLimitResponse,
  type CodexRateLimitSnapshot,
} from './schemas.js'

export type ProviderLimit = {
  label: string
  usedPercent: number
  resetsAt?: number | undefined
  valueLabel?: string | undefined
  action?: 'consume-reset' | undefined
  resetCredits?: { id?: string | undefined; expiresAt: number | null }[] | undefined
}

export type CodexLimitSource =
  { status: 'ready'; limits: ProviderLimit[] } | { status: 'unavailable' }

/** Same USD-per-credit rate OpenAI's own surfaces use. */
const CREDIT_USD_RATE = 0.04

/** Pure mapping kept separate from the app-server transport for fixture tests. */
export function mapCodexRateLimits(response: CodexRateLimitResponse): ProviderLimit[] {
  const buckets = response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId).filter(
        (pair): pair is [string, CodexRateLimitSnapshot] => Boolean(pair[1]),
      )
    : []
  if (response.rateLimits && !buckets.some(([limitId]) => limitId === 'codex')) {
    buckets.unshift(['codex', response.rateLimits])
  }
  // Ensure the main codex bucket always appears first.
  buckets.sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : 0))
  const rows: ProviderLimit[] = []
  for (const [limitId, snapshot] of buckets) {
    // Secondary buckets (e.g. Spark) carry their own name; the main
    // bucket falls back to the plain window label.
    const prefix = limitId === 'codex' ? '' : `${snapshot.limitName ?? titleCaseLimitId(limitId)} `
    rows.push(
      ...[snapshot.primary, snapshot.secondary].flatMap((window, index) => {
        if (!window) return []
        const usedPercent = finitePercent(window.usedPercent)
        if (usedPercent === undefined) return []
        const resetsAt = resetTimestamp(window.resetsAt)
        return [
          {
            label:
              friendlyLimitLabel(limitId, snapshot.limitName, window.windowDurationMins) ??
              prefix +
                rateLimitLabel(window.windowDurationMins, index === 0 ? 'Primary' : 'Secondary'),
            usedPercent,
            ...(!(resetsAt === undefined) ? { resetsAt } : {}),
          },
        ]
      }),
    )
  }
  const credits = (response.rateLimitsByLimitId?.['codex'] ?? response.rateLimits)?.credits
  if (credits?.hasCredits) {
    if (credits.unlimited) {
      rows.push({
        label: 'Credits',
        usedPercent: 0,
        valueLabel: 'Unlimited',
      })
    } else if (credits.balance !== null) {
      const balance = Math.max(0, Math.floor(Number(credits.balance)))
      if (Number.isFinite(balance)) {
        rows.push({
          label: 'Credits',
          usedPercent: 0,
          valueLabel: `$${(balance * CREDIT_USD_RATE).toFixed(2)} · ${balance} credits`,
        })
      }
    }
  }
  const resets = response.rateLimitResetCredits
  const availableResets = Number(resets?.availableCount)
  if (Number.isFinite(availableResets) && availableResets > 0) {
    const resetCredits = resets?.credits?.flatMap((credit) => {
      const parsed = CodexResetCreditSchema.safeParse(credit)
      if (!parsed.success) return []
      const { id, expiresAt } = parsed.data
      return [
        {
          ...(id === undefined ? {} : { id }),
          expiresAt: expiresAt === null ? null : expiresAt * 1000,
        },
      ]
    })
    rows.push({
      label: 'Rate limit resets',
      usedPercent: 0,
      valueLabel: `${Math.floor(availableResets)} available`,
      action: 'consume-reset',
      ...(resetCredits?.length ? { resetCredits } : {}),
    })
  }
  return rows
}

function finitePercent(value: number): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined
}

function resetTimestamp(value: number | null): number | undefined {
  if (value === null || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function titleCaseLimitId(limitId: string): string {
  return limitId
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Friendly names for the two weekly windows this account actually shows: the
 * main codex quota reads "Weekly", the Spark quota "Weekly Spark".
 * Every other bucket or window keeps the raw duration label.
 */
function friendlyLimitLabel(
  limitId: string,
  limitName: string | null,
  windowDurationMins: number | null,
): string | undefined {
  if (windowDurationMins !== 7 * 24 * 60) return undefined
  if (limitId === 'codex') return 'Weekly'
  if (limitId === 'spark' || limitName?.toLowerCase().includes('spark')) return 'Weekly Spark'
  return undefined
}

function rateLimitLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return `${fallback} limit`
  }
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}
