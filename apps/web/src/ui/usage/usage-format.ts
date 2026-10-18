/** Number and date formats shared by the Usage page's sections. */

const integer = new Intl.NumberFormat('en-US')
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatInteger(value: number): string {
  return integer.format(Math.round(value))
}

export function formatMoney(value: number): string {
  return money.format(value)
}

/** "950", "12.3K", "1.23M", "51.4B": three significant figures at most. */
export function formatTokens(value: number): string {
  const absolute = Math.abs(value)
  if (absolute < 1_000) return formatInteger(value)
  const units = [
    { size: 1_000_000_000_000, suffix: 'T' },
    { size: 1_000_000_000, suffix: 'B' },
    { size: 1_000_000, suffix: 'M' },
    { size: 1_000, suffix: 'K' },
  ]
  const unit = units.find((candidate) => absolute >= candidate.size) ?? units.at(-1)
  if (!unit) return formatInteger(value)
  const scaled = value / unit.size
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
  return `${scaled.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, '')}${unit.suffix}`
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** "1 day", "17 days"; "7+ days" when the run may go on before the range starts. */
export function formatDays(value: number, open = false): string {
  return `${formatInteger(value)}${open ? '+' : ''} ${value === 1 && !open ? 'day' : 'days'}`
}

/** A day key ("2026-10-17") at local noon, so no time zone moves it to another day. */
export function dateFromKey(value: string): Date {
  const [year = 1970, month = 1, day = 1] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

export function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dateFromKey(value))
}

export function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    dateFromKey(value),
  )
}

/** "Sep 18 to Oct 17, 2026"; the first year only when the two differ. */
export function formatDateRange(start: string, end: string): string {
  if (start === end) return formatLongDate(start)
  const startDate = dateFromKey(start)
  const endDate = dateFromKey(end)
  const sameYear = startDate.getFullYear() === endDate.getFullYear()
  const first = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(startDate)
  return `${first} to ${formatLongDate(end)}`
}
