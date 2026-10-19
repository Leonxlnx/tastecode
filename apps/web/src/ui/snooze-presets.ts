/** Snooze times offered by the sidebars, and how a wake time reads. */

export function snoozePresets(now: number): Array<{ label: string; at: number }> {
  return [
    { label: 'In one hour', at: now + 60 * 60 * 1_000 },
    { label: 'This evening', at: thisEvening(now) },
    { label: 'Tomorrow morning', at: tomorrowMorning(now) },
    { label: 'Next week', at: nextWeek(now) },
  ]
}

function thisEvening(now: number): number {
  const next = new Date(now)
  next.setHours(18, 0, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function tomorrowMorning(now: number): number {
  const next = new Date(now)
  next.setDate(next.getDate() + 1)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

function nextWeek(now: number): number {
  const next = new Date(now)
  const daysUntilMonday = (8 - next.getDay()) % 7 || 7
  next.setDate(next.getDate() + daysUntilMonday)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

export function formatWakeTime(at: number, now: number): string {
  const target = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const time = target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay(target, today)) return `Today · ${time}`
  if (sameDay(target, tomorrow)) return `Tomorrow · ${time}`
  return target.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
