/** Number and date formats shared by the Usage page's sections and the account popup. */

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

/** A day key ("2026-10-17") at local noon, so no time zone moves it to another day. */
export function dateFromKey(value: string): Date {
  const [year = 1970, month = 1, day = 1] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
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
