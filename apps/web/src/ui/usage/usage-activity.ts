import type { ProviderId, UsageHistoryDay } from '@harness/contracts'

/** Up to this many days the chart has a column per day; longer ranges go by week. */
export const MAX_DAY_COLUMNS = 92

export type ActivityColumn = {
  /** First and last day the column covers; the same day for a daily column. */
  startDate: string
  endDate: string
  tokens: number
  sessions: number
  /** Largest first. */
  providers: Array<{ provider: ProviderId; tokens: number }>
}

export type ActivityColumns = { unit: 'day' | 'week'; columns: ActivityColumn[] }

/**
 * The chart's columns, oldest first. Weeks are counted back from the last
 * day, so the newest column always ends today.
 */
export function activityColumns(daily: readonly UsageHistoryDay[]): ActivityColumns {
  const unit = daily.length > MAX_DAY_COLUMNS ? 'week' : 'day'
  const size = unit === 'week' ? 7 : 1
  const columns: ActivityColumn[] = []
  for (let end = daily.length; end > 0; end -= size) {
    const days = daily.slice(Math.max(0, end - size), end)
    const first = days[0]
    const last = days.at(-1)
    if (!first || !last) continue
    const providers = new Map<ProviderId, number>()
    let tokens = 0
    let sessions = 0
    for (const day of days) {
      tokens += day.totals.processedTokens
      sessions += day.sessionCount
      for (const entry of day.providers) {
        providers.set(entry.provider, (providers.get(entry.provider) ?? 0) + entry.tokens)
      }
    }
    columns.push({
      startDate: first.date,
      endDate: last.date,
      tokens,
      sessions,
      providers: [...providers]
        .filter(([, value]) => value > 0)
        .map(([provider, value]) => ({ provider, tokens: value }))
        .sort((left, right) => right.tokens - left.tokens),
    })
  }
  return { unit, columns: columns.reverse() }
}

/**
 * How many rungs of the ladder each provider fills in one column, bottom
 * first in `order`. The column's height is rounded to whole rungs, and any
 * use at all shows at least one, so a quiet day never reads as none. Rungs
 * are shared out by largest remainder, so the parts always add up.
 */
export function ladderRungs(
  column: ActivityColumn,
  maximum: number,
  rungs: number,
  order: readonly ProviderId[],
): Array<{ provider: ProviderId; rungs: number }> {
  if (column.tokens <= 0 || maximum <= 0) return []
  const total = Math.min(rungs, Math.max(1, Math.round((column.tokens / maximum) * rungs)))
  const parts = order
    .map((provider) => ({
      provider,
      tokens: column.providers.find((entry) => entry.provider === provider)?.tokens ?? 0,
    }))
    .filter((part) => part.tokens > 0)
  const sum = parts.reduce((value, part) => value + part.tokens, 0)
  if (sum <= 0) return []
  const shares = parts.map((part) => {
    const exact = (part.tokens / sum) * total
    return { provider: part.provider, rungs: Math.floor(exact), remainder: exact % 1 }
  })
  let left = total - shares.reduce((value, part) => value + part.rungs, 0)
  for (const part of shares.toSorted((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break
    part.rungs += 1
    left -= 1
  }
  return shares
    .filter((part) => part.rungs > 0)
    .map(({ provider, rungs: count }) => ({
      provider,
      rungs: count,
    }))
}

export type Streaks = {
  /** Active days in a row up to today, or up to yesterday when today has none yet. */
  current: number
  longest: number
  /** The run reaches the first day of the range, so it may be longer than shown. */
  currentOpen: boolean
  longestOpen: boolean
}

export function streaks(daily: readonly UsageHistoryDay[]): Streaks {
  let longest = 0
  let longestOpen = false
  let running = 0
  daily.forEach((day, index) => {
    if (day.totals.processedTokens <= 0) {
      running = 0
      return
    }
    running += 1
    if (running > longest) {
      longest = running
      longestOpen = running === index + 1
    }
  })

  let index = daily.length - 1
  if (index >= 0 && (daily[index]?.totals.processedTokens ?? 0) <= 0) index -= 1
  let current = 0
  while (index >= 0 && (daily[index]?.totals.processedTokens ?? 0) > 0) {
    current += 1
    index -= 1
  }
  return { current, longest, currentOpen: current > 0 && index < 0, longestOpen }
}

/** Daily average over the last `days` days, today included; undefined when the range is shorter. */
export function recentAverage(daily: readonly UsageHistoryDay[], days = 7): number | undefined {
  if (daily.length < days) return undefined
  const recent = daily.slice(-days)
  return recent.reduce((sum, day) => sum + day.totals.processedTokens, 0) / days
}

/** Providers by their share of the range, largest first: the ladder's bottom-up order. */
export function providerOrder(columns: readonly ActivityColumn[]): ProviderId[] {
  const totals = new Map<ProviderId, number>()
  for (const column of columns) {
    for (const entry of column.providers) {
      totals.set(entry.provider, (totals.get(entry.provider) ?? 0) + entry.tokens)
    }
  }
  return [...totals].sort((left, right) => right[1] - left[1]).map(([provider]) => provider)
}
