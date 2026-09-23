/** Clock and label helpers for the thread sidebar. Pure, so rows and tests share one rule. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const EVENING_HOUR = 18
const MORNING_HOUR = 9

export type SnoozePreset = { id: string; label: string; when: string; at: number }

/** Elapsed time for a running thread: "42s", "5m", "1h 3m". */
export function elapsedTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Compact time since an event: "now", "5m", "6h", "3d". */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Time until a snoozed thread returns: "12m", "3h", "2d". Rounds up so it never reads "0m". */
export function wakeCountdown(wakeAt: number, now: number): string {
  const remaining = wakeAt - now
  if (remaining <= 0) return 'now'
  if (remaining < HOUR) return `${Math.max(1, Math.ceil(remaining / MINUTE))}m`
  if (remaining < DAY) return `${Math.ceil(remaining / HOUR)}h`
  return `${Math.ceil(remaining / DAY)}d`
}

/** The wake time spelled out, for tooltips and accessible names. */
export function formatWakeTime(at: number, now: number): string {
  const target = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const time = timeOfDay(target)
  if (sameDay(target, today)) return `Today · ${time}`
  if (sameDay(target, tomorrow)) return `Tomorrow · ${time}`
  return target.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** Presets resolve when a menu opens, so "In 1 hour" is relative to the click. */
export function snoozePresets(now: number): SnoozePreset[] {
  const inAnHour = now + HOUR
  const inThreeHours = now + 3 * HOUR
  const presets: SnoozePreset[] = [
    { id: 'hour', label: 'In 1 hour', when: timeOfDay(new Date(inAnHour)), at: inAnHour },
    {
      id: 'three-hours',
      label: 'In 3 hours',
      when: timeOfDay(new Date(inThreeHours)),
      at: inThreeHours,
    },
  ]
  const evening = atHour(new Date(now), EVENING_HOUR)
  if (evening.getTime() - now > HOUR) {
    presets.push({
      id: 'evening',
      label: 'This evening',
      when: timeOfDay(evening),
      at: evening.getTime(),
    })
  }
  const tomorrow = atHour(addDays(new Date(now), 1), MORNING_HOUR)
  presets.push({
    id: 'tomorrow',
    label: 'Tomorrow',
    when: timeOfDay(tomorrow),
    at: tomorrow.getTime(),
  })
  const today = new Date(now)
  const daysUntilMonday = (1 - today.getDay() + 7) % 7 || 7
  const nextWeek = atHour(addDays(today, daysUntilMonday), MORNING_HOUR)
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: 'next-week',
      label: 'Next week',
      when: `${nextWeek.toLocaleDateString([], { weekday: 'short' })} ${timeOfDay(nextWeek)}`,
      at: nextWeek.getTime(),
    })
  }
  return presets
}

/** Local `datetime-local` value for a timestamp. */
export function localDateTimeValue(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** Reads a `datetime-local` value; rejects invalid and past times. */
export function parseCustomSnooze(value: string, now: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined
  const at = new Date(value).getTime()
  // A nonexistent local time (DST gap) rolls over; reject it instead of guessing.
  if (!Number.isFinite(at) || localDateTimeValue(at) !== value) return undefined
  return at > now ? at : undefined
}

/**
 * Milliseconds until the next visible label changes, or undefined when nothing can
 * change. Running threads tick every second; everything else sleeps until its
 * own label moves, so an idle sidebar never wakes.
 */
export function inboxClockDelay(
  hasRunningThread: boolean,
  relativeTimes: readonly number[],
  wakeTimes: readonly number[],
  now: number,
): number | undefined {
  if (hasRunningThread) return 1_000
  let nextChangeAt = Number.POSITIVE_INFINITY
  for (const timestamp of relativeTimes) {
    if (Number.isFinite(timestamp)) {
      nextChangeAt = Math.min(nextChangeAt, nextRelativeTimeChangeAt(timestamp, now))
    }
  }
  for (const wakeAt of wakeTimes) {
    const changeAt = nextWakeCountdownChangeAt(wakeAt, now)
    if (changeAt !== undefined) nextChangeAt = Math.min(nextChangeAt, changeAt)
  }
  return Number.isFinite(nextChangeAt) ? Math.max(1_000, nextChangeAt - now) : undefined
}

function nextRelativeTimeChangeAt(timestamp: number, now: number): number {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000))
  if (seconds < 60) return timestamp + 59_500

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return timestamp + ((minutes + 1) * 60 - 30) * 1_000 - 500

  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    const nextMinutes = (hours + 1) * 60 - 30
    return timestamp + (nextMinutes * 60 - 30) * 1_000 - 500
  }

  const days = Math.round(hours / 24)
  const nextHours = (days + 1) * 24 - 12
  const nextMinutes = nextHours * 60 - 30
  return timestamp + (nextMinutes * 60 - 30) * 1_000 - 500
}

/**
 * Wake countdowns read the minute clock, so a change is scheduled on the first
 * minute boundary after the countdown actually moves.
 */
function nextWakeCountdownChangeAt(wakeAt: number, now: number): number | undefined {
  const remaining = wakeAt - now
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined
  const unit = remaining <= HOUR ? MINUTE : remaining <= DAY ? HOUR : DAY
  const step = remaining % unit || unit
  const changeAt = now + step
  return Math.ceil(changeAt / MINUTE) * MINUTE
}

function timeOfDay(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base)
  next.setHours(hour, 0, 0, 0)
  return next
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base)
  next.setDate(next.getDate() + days)
  return next
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
