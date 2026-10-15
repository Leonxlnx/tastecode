import { useState, type CSSProperties } from 'react'

export type ReelColumn =
  | { kind: 'fixed'; char: string; changed: boolean }
  | { kind: 'wheel'; from: string; to: string; order: number }

/**
 * Lines two versions up the way an odometer would: part by part, digits
 * right-aligned within each part, so only the characters that differ become
 * wheels. A part that changed at all counts as changed, so `158 → 159` lights
 * up whole even though one wheel turns.
 */
export function alignVersions(from: string, to: string): ReelColumn[] {
  const fromParts = from.split(/([.\-+])/)
  const toParts = to.split(/([.\-+])/)
  const columns: ReelColumn[] = []
  for (let part = 0; part < Math.max(fromParts.length, toParts.length); part++) {
    const before = [...(fromParts[part] ?? '')]
    const after = [...(toParts[part] ?? '')]
    const width = Math.max(before.length, after.length)
    const changed = fromParts[part] !== toParts[part]
    for (let index = 0; index < width; index++) {
      const a = before[index - width + before.length] ?? ''
      const b = after[index - width + after.length] ?? ''
      columns.push(
        a === b ? { kind: 'fixed', char: a, changed } : { kind: 'wheel', from: a, to: b, order: 0 },
      )
    }
  }
  // Wheels turn from the right, like a carry.
  let order = 0
  for (const column of columns.toReversed()) if (column.kind === 'wheel') column.order = order++
  return columns
}

export type ReelTurn = 'rest' | 'turning' | 'turned'

/** The installed version as a row of wheels that turn over to the new one. */
export function VersionReel(props: { from: string; to: string; turn: ReelTurn }) {
  return (
    <span className="version-reel" data-turn={props.turn} aria-hidden>
      {alignVersions(props.from, props.to).map((column, index) =>
        column.kind === 'fixed' ? (
          <span key={index} data-changed={column.changed || undefined}>
            {column.char}
          </span>
        ) : (
          <span
            key={index}
            className="version-reel__wheel"
            data-enter={!column.from || undefined}
            data-leave={!column.to || undefined}
            style={{ '--order': column.order } as CSSProperties}
          >
            <span className="version-reel__strip">
              <span>{column.from}</span>
              <span>{column.to}</span>
            </span>
          </span>
        ),
      )}
    </span>
  )
}

/** The new version on its own, with the parts that change brought forward. */
export function VersionTarget(props: { from: string; to: string }) {
  const runs: { text: string; changed: boolean }[] = []
  for (const column of alignVersions(props.from, props.to)) {
    const text = column.kind === 'fixed' ? column.char : column.to
    const changed = column.kind === 'wheel' || column.changed
    const last = runs.at(-1)
    if (last?.changed === changed) last.text += text
    else if (text) runs.push({ text, changed })
  }
  return (
    <span className="version-target" aria-hidden>
      {runs.map((run, index) => (
        <span key={index} data-changed={run.changed || undefined}>
          {run.text}
        </span>
      ))}
    </span>
  )
}

/** A small count that turns over on the same wheels whenever it changes. */
export function CountReel(props: { value: number }) {
  const [shown, setShown] = useState({ from: props.value, to: props.value })
  if (shown.to !== props.value) setShown({ from: shown.to, to: props.value })
  // A fresh reel per change starts at rest and turns once (see @starting-style).
  return (
    <VersionReel
      key={`${shown.from}:${shown.to}`}
      from={String(shown.from)}
      to={String(shown.to)}
      turn="turned"
    />
  )
}
