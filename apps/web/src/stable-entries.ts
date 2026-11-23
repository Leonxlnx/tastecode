import { useRef } from 'react'

/** Stands for a callback in an entry's data key; no message holds a NUL character. */
const CALLBACK = '\u0000callback'

/**
 * One identity for a list of plain-data entries with callbacks, for as long as
 * their data stays the same. A list rebuilt on every render re-renders every
 * memoized component it is handed. Each callback of a kept list calls the one
 * at the same place in the newest render's list, so keeping a list never runs
 * a stale callback.
 */
export function useStableEntries<T extends object>(entries: readonly T[]): readonly T[] {
  const latest = useRef(entries)
  latest.current = entries
  const kept = useRef<{ key: string; entries: readonly T[] } | undefined>(undefined)
  const key = JSON.stringify(entries, (_name, value: unknown) =>
    typeof value === 'function' ? CALLBACK : value,
  )
  if (kept.current?.key !== key) {
    kept.current = {
      key,
      entries: entries.map((entry, index) => routed(entry, [index], latest)),
    }
  }
  return kept.current.entries
}

function routed<V>(value: V, path: readonly PropertyKey[], latest: { current: unknown }): V {
  if (typeof value === 'function') {
    const call = (...args: unknown[]) => {
      const current = path.reduce(
        (node: unknown, step) =>
          typeof node === 'object' && node !== null
            ? (node as Record<PropertyKey, unknown>)[step]
            : undefined,
        latest.current,
      )
      return typeof current === 'function'
        ? (current as (...a: unknown[]) => unknown)(...args)
        : undefined
    }
    return call as V
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => routed(item, [...path, index], latest)) as V
  }
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, routed(item, [...path, name], latest)]),
  ) as V
}
