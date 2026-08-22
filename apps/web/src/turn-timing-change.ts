const changedTurnIds = new WeakMap<object, string>()
const timingOverlays = new WeakMap<object, TimingOverlay>()
const MAX_TIMING_OVERLAY_DEPTH = 128

export type TurnTimingEntry = { startedAt?: number; completedAt?: number }
export interface TurnTimingRecord {
  readonly [turnId: string]: TurnTimingEntry
}
export interface MutableTurnTimingRecord {
  [turnId: string]: TurnTimingEntry
}

type TimingOverlay = {
  base: TurnTimingRecord
  updates: ReadonlyMap<string, TurnTimingEntry>
  depth: number
  keys?: string[] | undefined
}

/** Marks the one live turn timing entry changed by a reducer event. */
export function markTurnTimingChange<T extends object>(timing: T, turnId: string): T {
  changedTurnIds.set(timing, turnId)
  return timing
}

export function changedTurnTimingId(timing: object): string | undefined {
  return changedTurnIds.get(timing)
}

/**
 * Adds one immutable timing entry without copying the whole history.
 *
 * A live turn changes this table only at its start and completion. Each update
 * is therefore one small Map overlay over the flat replay record. The overlay
 * is flattened at a fixed depth so retained memory and update allocation stay
 * bounded even when the app remains open for thousands of turns.
 */
export function updateTurnTiming(
  timing: TurnTimingRecord,
  turnId: string,
  entry: TurnTimingEntry,
): TurnTimingRecord {
  const current = timingOverlays.get(timing)
  if ((current?.depth ?? 0) >= MAX_TIMING_OVERLAY_DEPTH) {
    const compacted = materializeTurnTiming(timing)
    writeTimingEntry(compacted, turnId, entry)
    return markTurnTimingChange(compacted, turnId)
  }

  const updates = new Map(current?.updates)
  updates.set(turnId, entry)
  const next = createTimingOverlay({
    base: current?.base ?? timing,
    updates,
    depth: (current?.depth ?? 0) + 1,
  })
  return markTurnTimingChange(next, turnId)
}

/** Materializes a timing overlay for replay mutation or serialization. */
export function materializeTurnTiming(timing: TurnTimingRecord): MutableTurnTimingRecord {
  const materialized: MutableTurnTimingRecord = {}
  const overlay = timingOverlays.get(timing)
  const base = overlay?.base ?? timing
  for (const turnId of Object.keys(base)) {
    const entry = base[turnId]
    if (entry) writeTimingEntry(materialized, turnId, entry)
  }
  for (const [turnId, entry] of overlay?.updates ?? []) {
    writeTimingEntry(materialized, turnId, entry)
  }
  return materialized
}

/** Enumerates both the flat base and any bounded live timing overlay. */
export function turnTimingKeys(timing: TurnTimingRecord): string[] {
  const overlay = timingOverlays.get(timing)
  return overlay ? [...timingOverlayKeys(overlay)] : Object.keys(timing)
}

function createTimingOverlay(overlay: TimingOverlay): TurnTimingRecord {
  const target = {}
  const timing = new Proxy(target, {
    deleteProperty: () => false,
    defineProperty: () => false,
    get: (_target, property, receiver) => {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      const updated = overlay.updates.get(property)
      if (updated !== undefined) return updated
      const recorded = overlay.base[property]
      if (recorded !== undefined) return recorded
      return Reflect.get(target, property, receiver)
    },
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property !== 'string' || !timingOverlayHas(overlay, property)) return undefined
      return {
        configurable: true,
        enumerable: true,
        value: timingOverlayEntry(overlay, property),
        writable: false,
      }
    },
    has: (_target, property) =>
      (typeof property === 'string' && timingOverlayHas(overlay, property)) ||
      Reflect.has(target, property),
    ownKeys: () => timingOverlayKeys(overlay),
    preventExtensions: () => false,
    set: () => false,
  }) as TurnTimingRecord
  timingOverlays.set(timing, overlay)
  return timing
}

function timingOverlayEntry(overlay: TimingOverlay, turnId: string): TurnTimingEntry | undefined {
  return overlay.updates.get(turnId) ?? overlay.base[turnId]
}

function timingOverlayHas(overlay: TimingOverlay, turnId: string): boolean {
  return overlay.updates.has(turnId) || Object.hasOwn(overlay.base, turnId)
}

function timingOverlayKeys(overlay: TimingOverlay): string[] {
  if (overlay.keys) return overlay.keys
  const keys = Object.keys(overlay.base)
  for (const turnId of overlay.updates.keys()) {
    if (!Object.hasOwn(overlay.base, turnId)) keys.push(turnId)
  }
  overlay.keys = keys
  return keys
}

function writeTimingEntry(
  timing: MutableTurnTimingRecord,
  turnId: string,
  entry: TurnTimingEntry,
): void {
  Object.defineProperty(timing, turnId, {
    configurable: true,
    enumerable: true,
    value: entry,
    writable: true,
  })
}
