import type {
  ProviderId,
  ResultOf,
  UsageHistoryModel,
  UsageHistoryRange,
  UsageHistoryTotals,
} from '@harness/contracts'
import { providerDisplayName } from '../../provider-presentation.js'
import type { UsageSummaryState } from '../../usage-summary-state.js'
import { limitSource, remaining, sourceStatus } from '../AccountLimits.js'
import { dateFromKey, formatMoney } from './usage-format.js'

type History = ResultOf<'usage.history'>
type Limit = ResultOf<'usage.summary'>['limits'][number]

/** The plan limits the app keeps for every provider; the account popup reads the same owner. */
export type PlanLimitsSource = {
  snapshot(): UsageSummaryState[]
  subscribe(listener: () => void): () => void
  refresh(provider?: ProviderId): void
}

/** At or under this share left, a window reads as running low. */
const LOW_SHARE = 15

/** The scale is capped at this multiple of the 98th percentile of active days. */
const CAP_MULTIPLE = 1.5
const CAP_PERCENTILE = 0.02

/** A provider whose busiest day stays under this share of the scale is drawn as ticks. */
const QUIET_SHARE = 0.04

/** The value is a partial estimate under this share of priced tokens. */
const FULL_ESTIMATE_SHARE = 0.95

export type SheetDay = { tokens: number; value: number }

export type SheetLimit = {
  label: string
  /** Share left, 0 to 100. */
  left: number
  state: 'ok' | 'low' | 'reached'
  resetsAt?: number | undefined
  /** A window the provider reports as text instead of a share. */
  valueLabel?: string | undefined
}

export type SheetLimits = {
  rows: SheetLimit[]
  /** Why the rows are missing or stale; undefined when they are current. */
  status?: { label: string; detail?: string | undefined } | undefined
  retryable: boolean
}

export type ProviderSheet = {
  provider: ProviderId
  name: string
  sessions: number
  tokens: number
  value: number
  activeDays: number
  /** One entry per day of the history, in its order. */
  daily: SheetDay[]
  /** Its use is too small to rise on the shared scale. */
  quiet: boolean
  /** No sessions in the period: the sheet collapses to one row and its limits. */
  empty: boolean
  /** By value, then tokens. */
  models: UsageHistoryModel[]
  limits: SheetLimits
}

export type UsageSheets = {
  sheets: ProviderSheet[]
  /** The height every band shares, in tokens a day. */
  top: number
  capped: boolean
}

const NO_LIMITS: SheetLimits = { rows: [], retryable: false }

function sheetLimit(limit: Limit): SheetLimit {
  const left = remaining(limit)
  const textual = limit.valueLabel !== undefined
  // Reached only when the provider says it is used up, not when 0.4% rounds to none.
  const state =
    !textual && limit.usedPercent >= 100 ? 'reached' : !textual && left <= LOW_SHARE ? 'low' : 'ok'
  return {
    label: limit.label,
    left,
    state,
    resetsAt: limit.resetsAt,
    valueLabel: limit.valueLabel,
  }
}

/** A provider's limits, or undefined when its source reports no plan limits at all. */
export function sheetLimits(state: UsageSummaryState): SheetLimits | undefined {
  const source = limitSource(state)
  if (source?.status === 'unavailable') return undefined
  const limits = source?.status === 'ready' ? source.limits : []
  return {
    rows: limits.map(sheetLimit),
    // A source that answered without windows reads as having none, not as a status.
    status:
      state.status === 'error' || source === undefined
        ? sourceStatus(state, source, limits.length > 0)
        : undefined,
    retryable: state.status === 'error',
  }
}

/**
 * One sheet per provider found in the history or the plan limits, by value,
 * with providers that had no sessions last. Every band shares one linear
 * scale; when the busiest day is far above the rest the scale is capped so
 * one day does not flatten every other.
 */
export function deriveSheets(
  history: History | undefined,
  limits: ReadonlyMap<ProviderId, SheetLimits>,
): UsageSheets {
  const ids: ProviderId[] = [...limits.keys()]
  for (const entry of history?.providers ?? []) {
    if (!ids.includes(entry.provider)) ids.push(entry.provider)
  }
  const days = history?.daily ?? []
  const sheets = ids.map((provider): ProviderSheet => {
    const summary = history?.providers.find((entry) => entry.provider === provider)
    const daily = days.map((day) => {
      const share = day.providers.find((entry) => entry.provider === provider)
      return { tokens: share?.tokens ?? 0, value: share?.estimatedCostUsd ?? 0 }
    })
    const activeDays = daily.filter((day) => day.tokens > 0).length
    const sessions = summary?.sessionCount ?? 0
    return {
      provider,
      name: providerDisplayName(provider),
      sessions,
      tokens: summary?.totals.processedTokens ?? 0,
      value: summary?.totals.estimatedCostUsd ?? 0,
      activeDays,
      daily,
      quiet: false,
      empty: sessions === 0 && activeDays === 0,
      models: (history?.models ?? [])
        .filter((model) => model.provider === provider)
        .toSorted(
          (left, right) =>
            right.totals.estimatedCostUsd - left.totals.estimatedCostUsd ||
            right.totals.processedTokens - left.totals.processedTokens,
        ),
      limits: limits.get(provider) ?? NO_LIMITS,
    }
  })
  sheets.sort((left, right) => Number(left.empty) - Number(right.empty) || right.value - left.value)

  const pooled = sheets
    .flatMap((sheet) => sheet.daily.map((day) => day.tokens))
    .filter((tokens) => tokens > 0)
    .toSorted((left, right) => right - left)
  const max = pooled[0] ?? 0
  const cap = (pooled[Math.floor(pooled.length * CAP_PERCENTILE)] ?? max) * CAP_MULTIPLE
  const capped = max > cap
  const top = capped ? cap : max
  for (const sheet of sheets) {
    const peak = Math.max(0, ...sheet.daily.map((day) => day.tokens))
    sheet.quiet = sheet.activeDays > 0 && peak < top * QUIET_SHARE
  }
  return { sheets, top, capped }
}

/** Share of tokens with a public or provider-reported price, or undefined without tokens. */
export function pricedShare(totals: UsageHistoryTotals): number | undefined {
  if (totals.processedTokens <= 0) return undefined
  return (totals.pricedTokens + totals.providerReportedTokens) / totals.processedTokens
}

export function isPartialEstimate(totals: UsageHistoryTotals): boolean {
  const share = pricedShare(totals)
  return share !== undefined && share < FULL_ESTIMATE_SHARE
}

/** "$1,234.56", and "under $0.01" for a value that would round to nothing. */
export function formatValue(value: number): string {
  return value > 0 && value < 0.005 ? 'under $0.01' : formatMoney(value)
}

const PERIODS = {
  '7d': { label: 'Last 7 days', within: 'in the last 7 days' },
  '30d': { label: 'Last 30 days', within: 'in the last 30 days' },
  '90d': { label: 'Last 90 days', within: 'in the last 90 days' },
  '365d': { label: 'Last year', within: 'in the last year' },
  all: { label: 'All time', within: 'yet' },
} as const satisfies Record<UsageHistoryRange, { label: string; within: string }>

export const PERIOD_OPTIONS = Object.entries(PERIODS).map(([value, period]) => ({
  value: value as UsageHistoryRange,
  label: period.label,
}))

export function isPeriod(value: string): value is UsageHistoryRange {
  return Object.hasOwn(PERIODS, value)
}

export function emptySheetText(range: UsageHistoryRange): string {
  return `No sessions ${PERIODS[range].within}`
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * "resets in 42m" and "resets in 3h 12m" within a day, the weekday and time
 * within the week, the date after that. The exact time is kept for hover.
 */
export function resetText(at: number, now: number): { label: string; title: string } | undefined {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return undefined
  const title = `${weekday.format(date)}, ${monthDay.format(date)}, ${clock.format(date)}`
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return { label: 'resets now', title }
  if (minutes < 60) return { label: `resets in ${minutes}m`, title }
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return { label: `resets in ${hours}h${rest > 0 ? ` ${rest}m` : ''}`, title }
  }
  const label =
    at - now < 6 * 86_400_000
      ? `${weekday.format(date)} ${clock.format(date)}`
      : monthDay.format(date)
  return { label: `resets ${label}`, title }
}

/**
 * The sentence under the top line that names every limit running low or
 * reached, reached first, or undefined when none is.
 */
export function limitAlert(sheets: readonly ProviderSheet[], now: number): string | undefined {
  const reached: string[] = []
  const low: string[] = []
  for (const sheet of sheets) {
    for (const limit of sheet.limits.rows) {
      if (limit.state === 'ok') continue
      const reset = limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, now)
      const name = `${sheet.name} ${limit.label.toLowerCase()} limit`
      const tail = reset ? `, ${reset.label}` : ''
      if (limit.state === 'reached') reached.push(`${name} reached${tail}`)
      else low.push(`${name} at ${limit.left}% left${tail}`)
    }
  }
  const parts = [...reached, ...low]
  return parts.length > 0 ? `${parts.join('. ')}.` : undefined
}

/** "Oct 3", "Sat, Oct 3", with the year when it is not the reference year. */
export function dayText(key: string, referenceYear: number, withWeekday = false): string {
  const date = dateFromKey(key)
  return new Intl.DateTimeFormat('en-US', {
    ...(withWeekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === referenceYear ? {} : { year: 'numeric' }),
  }).format(date)
}

/** The local calendar day of a Unix time, as the history keys its days. */
export function dayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function indexedAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** "Codex", "Codex and Grok", "Claude Code, Codex and Grok". */
export function listText(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
