export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function timestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}
