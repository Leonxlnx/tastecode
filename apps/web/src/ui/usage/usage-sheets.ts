import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ProviderId,
  type ResultOf,
  type UsageHistoryModel,
  type UsageHistoryProvider,
  type UsageHistoryRange,
  type UsageHistoryTotals,
  type UsageReadIntent,
} from '@harness/contracts'
import type { AccountLabel } from '../../provider-accounts-state.js'
import { providerDisplayName, type ProviderMark } from '../../provider-presentation.js'
import { limitKey, limitTargetOf } from '../../usage-limits-state.js'
import type { UsageSummaryState } from '../../usage-summary-state.js'
import { limitSource, remaining, sourceStatus } from '../AccountLimits.js'
import { dateFromKey, formatMoney } from './usage-format.js'

type History = ResultOf<'usage.history'>
type Limit = ResultOf<'usage.summary'>['limits'][number]

/** The plan limits the app keeps for every provider; the account popup reads the same owner. */
export type PlanLimitsSource = {
  snapshot(): UsageSummaryState[]
  subscribe(listener: () => void): () => void
  /** A view shows the limits until the returned release is called. */
  show(): () => void
  refresh(provider?: ProviderId, intent?: UsageReadIntent, accountId?: AccountId): void
}

/** At or under this share left, a window reads as running low. */
const LOW_SHARE = 15

/** The value is a partial estimate under this share of priced tokens. */
const FULL_ESTIMATE_SHARE = 0.95

/** A period longer than this many days is drawn a week to a slot. */
const DAILY_DAYS = 92

/** One provider's share of one slot of the time axis. */
export type SheetSlot = { tokens: number; value: number }

/** One step of the shared time axis: a day, or a week on a long period. */
export type PeriodSlot = {
  start: string
  end: string
  tokens: number
  value: number
  activeDays: number
  /** Sessions are counted per day, so a week cannot sum them. */
  sessions?: number | undefined
}

/** A labelled point on the time axis, between its first and last slot. */
export type AxisTick = { index: number; label: string }

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

/** Usage and plan limits under one sign-in. */
export type SheetAccount = {
  key: string
  /** Absent for the provider's default account. */
  accountId?: AccountId | undefined
  label: string
  sessions: number
  tokens: number
  value: number
  limits: SheetLimits
}

export type ProviderSheet = {
  provider: ProviderId
  name: string
  sessions: number
  tokens: number
  value: number
  activeDays: number
  /** One entry per slot of the period, in its order. */
  slots: SheetSlot[]
  /** No sessions in the period: the sheet collapses to one row and its limits. */
  empty: boolean
  /** By value, then tokens. */
  models: UsageHistoryModel[]
  /**
   * One per sign-in: the default account first, then the others by name. A
   * provider used and read on its default account alone has one, named after
   * the provider.
   */
  accounts: SheetAccount[]
}

export type UsageSheets = {
  sheets: ProviderSheet[]
  /** The time axis every chart shares. */
  slots: PeriodSlot[]
  /** Days to a slot: 1, or 7 on a long period. */
  span: 1 | 7
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
export function sheetLimits(state: UsageSummaryState, now: number): SheetLimits | undefined {
  const source = limitSource(state)
  // A source that could not be read stays, so its failure and Retry show.
  if (source?.status === 'unavailable' && source.reason !== 'failed') return undefined
  const limits = source?.status === 'ready' ? source.limits : []
  return {
    rows: limits.map(sheetLimit),
    // A source that answered without windows reads as having none, not as a status.
    status:
      source?.status === 'ready' && limits.length === 0 && state.status !== 'error'
        ? undefined
        : sourceStatus(state, source, limits.length > 0, now),
    // Automatic retries run on their own; the button returns once they stop.
    retryable:
      !(state.status !== 'ready' && state.retry) &&
      (state.status === 'error' || (state.status === 'ready' && source?.status === 'unavailable')),
  }
}

/** Index ranges of the slots, each `span` days, the last ending on the last day. */
function slotRanges(days: number, span: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let end = days - 1; end >= 0; end -= span) ranges.unshift([Math.max(0, end - span + 1), end])
  return ranges
}

function sum<T>(items: readonly T[], read: (item: T) => number): number {
  return items.reduce((total, item) => total + read(item), 0)
}

const defaultLabel: AccountLabel = (_provider, accountId) =>
  accountId === undefined || accountId === DEFAULT_ACCOUNT_ID ? 'Default' : 'Account'

/**
 * A provider's accounts: each one with usage in the period or plan limits to
 * show. Only the default account with both reads as the provider itself.
 */
function sheetAccounts(
  provider: ProviderId,
  name: string,
  rows: readonly UsageHistoryProvider[],
  limits: ReadonlyMap<string, SheetLimits>,
  label: AccountLabel,
): SheetAccount[] {
  const ids = new Set<AccountId>()
  for (const row of rows) ids.add(row.accountId ?? DEFAULT_ACCOUNT_ID)
  for (const key of limits.keys()) {
    const target = limitTargetOf(key)
    if (target.provider === provider) ids.add(target.accountId ?? DEFAULT_ACCOUNT_ID)
  }
  const single = ids.size === 0 || (ids.size === 1 && ids.has(DEFAULT_ACCOUNT_ID))
  const accounts = [...ids].map((id): SheetAccount => {
    const accountId = id === DEFAULT_ACCOUNT_ID ? undefined : id
    const own = rows.filter((row) => (row.accountId ?? DEFAULT_ACCOUNT_ID) === id)
    return {
      key: limitKey(provider, accountId),
      ...(accountId === undefined ? {} : { accountId }),
      label: single ? name : label(provider, accountId),
      sessions: sum(own, (row) => row.sessionCount),
      tokens: sum(own, (row) => row.totals.processedTokens),
      value: sum(own, (row) => row.totals.estimatedCostUsd),
      limits: limits.get(limitKey(provider, accountId)) ?? NO_LIMITS,
    }
  })
  if (accounts.length === 0) {
    return [{ key: provider, label: name, sessions: 0, tokens: 0, value: 0, limits: NO_LIMITS }]
  }
  // The default account first, then the others by name, so the order holds
  // across periods and refreshes.
  return accounts.sort(
    (left, right) =>
      Number(left.accountId !== undefined) - Number(right.accountId !== undefined) ||
      left.label.localeCompare(right.label),
  )
}

/**
 * One sheet per provider found in the history or the plan limits, by value,
 * with providers that had no sessions last. Every chart shares one time
 * axis; a period longer than a quarter is drawn a week to a slot. `limits`
 * is keyed by provider account (`limitKey`); a provider with more than one
 * account in either lists them, named by `label`.
 */
export function deriveSheets(
  history: History | undefined,
  limits: ReadonlyMap<string, SheetLimits>,
  label: AccountLabel = defaultLabel,
): UsageSheets {
  const ids: ProviderId[] = []
  for (const key of limits.keys()) {
    const { provider } = limitTargetOf(key)
    if (!ids.includes(provider)) ids.push(provider)
  }
  for (const entry of history?.providers ?? []) {
    if (!ids.includes(entry.provider)) ids.push(entry.provider)
  }
  const days = history?.daily ?? []
  const span = days.length > DAILY_DAYS ? 7 : 1
  const ranges = slotRanges(days.length, span).map(([from, to]) => days.slice(from, to + 1))
  const slots = ranges.map((range): PeriodSlot => ({
    start: range[0]?.date ?? '',
    end: range.at(-1)?.date ?? '',
    tokens: sum(range, (day) => day.totals.processedTokens),
    value: sum(range, (day) => day.totals.estimatedCostUsd),
    activeDays: range.filter((day) => day.totals.processedTokens > 0).length,
    sessions: span === 1 ? sum(range, (day) => day.sessionCount) : undefined,
  }))
  const sheets = ids.map((provider): ProviderSheet => {
    // A provider split by account has one row per account; the sheet is their sum.
    const rows = history?.providers.filter((entry) => entry.provider === provider) ?? []
    const share = (day: (typeof days)[number]) =>
      day.providers.find((entry) => entry.provider === provider)
    const activeDays = days.filter((day) => (share(day)?.tokens ?? 0) > 0).length
    const name = providerDisplayName(provider)
    const sessions = sum(rows, (row) => row.sessionCount)
    const tokens = sum(rows, (row) => row.totals.processedTokens)
    const value = sum(rows, (row) => row.totals.estimatedCostUsd)
    return {
      provider,
      name,
      sessions,
      tokens,
      value,
      activeDays,
      slots: ranges.map((range) => ({
        tokens: sum(range, (day) => share(day)?.tokens ?? 0),
        value: sum(range, (day) => share(day)?.estimatedCostUsd ?? 0),
      })),
      empty: sessions === 0 && activeDays === 0,
      models: (history?.models ?? [])
        .filter((model) => model.provider === provider)
        .toSorted(
          (left, right) =>
            right.totals.estimatedCostUsd - left.totals.estimatedCostUsd ||
            right.totals.processedTokens - left.totals.processedTokens,
        ),
      accounts: sheetAccounts(provider, name, rows, limits, label),
    }
  })
  sheets.sort((left, right) => Number(left.empty) - Number(right.empty) || right.value - left.value)
  return { sheets, slots, span }
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthName = new Intl.DateTimeFormat('en-US', { month: 'short' })

/** "Mar", and the year in January's place so a long axis keeps its years. */
function monthText(date: Date): string {
  return date.getMonth() === 0 ? String(date.getFullYear()) : monthName.format(date)
}

/**
 * The labels between the axis ends: every weekday on a week, Mondays on a
 * month, and month starts on anything longer.
 */
export function axisTicks(slots: readonly PeriodSlot[], span: 1 | 7): AxisTick[] {
  const ticks: AxisTick[] = []
  for (let index = 1; index < slots.length - 1; index += 1) {
    const slot = slots[index]
    if (!slot) continue
    const start = dateFromKey(slot.start)
    if (span === 7) {
      // The week that holds the first of a month carries that month.
      const end = dateFromKey(slot.end)
      const first =
        start.getDate() === 1 ? start : end.getDate() < start.getDate() ? end : undefined
      if (first) ticks.push({ index, label: monthText(first) })
    } else if (slots.length <= 14) {
      ticks.push({ index, label: weekday.format(start) })
    } else if (slots.length <= 45) {
      if (start.getDay() === 1) ticks.push({ index, label: monthDay.format(start) })
    } else if (start.getDate() === 1) {
      ticks.push({ index, label: monthText(start) })
    }
  }
  return ticks
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

/** A provider's colour: its brand mark's token, grey for a mark without one. */
export function markInk(mark: ProviderMark): string {
  return `var(--mark-${mark}, var(--text-2))`
}

/** One provider's share of the period's tokens, for the bar under the totals. */
export type ProviderShare = { provider: ProviderId; name: string; share: number }

/** Each provider with tokens in the period, in sheet order, and its share of them. */
export function providerShares(sheets: readonly ProviderSheet[]): ProviderShare[] {
  const total = sum(sheets, (sheet) => sheet.tokens)
  if (total <= 0) return []
  return sheets
    .filter((sheet) => sheet.tokens > 0)
    .map((sheet) => ({ provider: sheet.provider, name: sheet.name, share: sheet.tokens / total }))
}

/** "81%", "0.4%" under one percent, and "under 0.1%" below that. */
export function shareText(share: number): string {
  const percent = share * 100
  if (percent >= 1) return `${Math.round(percent)}%`
  if (percent >= 0.1) return `${percent.toFixed(1)}%`
  return 'under 0.1%'
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
    for (const account of sheet.accounts) {
      const owner = sheet.accounts.length > 1 ? `${sheet.name} ${account.label}` : sheet.name
      for (const limit of account.limits.rows) {
        if (limit.state === 'ok') continue
        const reset = limit.resetsAt === undefined ? undefined : resetText(limit.resetsAt, now)
        const name = `${owner} ${limit.label.toLowerCase()} limit`
        const tail = reset ? `, ${reset.label}` : ''
        if (limit.state === 'reached') reached.push(`${name} reached${tail}`)
        else low.push(`${name} at ${limit.left}% left${tail}`)
      }
    }
  }
  const parts = [...reached, ...low]
  return parts.length > 0 ? `${parts.join('. ')}.` : undefined
}

/** "Oct 6 – 12", "Sep 29 – Oct 5", with the year when it is not the reference year. */
export function rangeText(start: string, end: string, referenceYear: number): string {
  if (start === end) return dayText(start, referenceYear, true)
  const from = dateFromKey(start)
  const to = dateFromKey(end)
  if (from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth()) {
    const year = to.getFullYear() === referenceYear ? '' : `, ${to.getFullYear()}`
    return `${monthDay.format(from)} – ${to.getDate()}${year}`
  }
  // Within one year, the year is named once, at the end.
  const head = dayText(
    start,
    from.getFullYear() === to.getFullYear() ? from.getFullYear() : referenceYear,
  )
  return `${head} – ${dayText(end, referenceYear)}`
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
