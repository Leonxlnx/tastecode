import type { Item } from '@harness/contracts'
import { liveItemChangesSince, threadItemAt, type LiveItemUpdate } from '../thread-store.js'
import { isBlankReasoning } from './turns.js'

/**
 * A run of structurally blank reasoning starting at one index: where it ends
 * (the first row that is not blank reasoning, or the array's length) and the
 * length it was answered at; plus, for the live snapshot last seen, the first
 * row in the run a streamed delta made visible (`end` when none did).
 */
type BlankRun = {
  end: number
  length: number
  live: ReadonlyMap<number, LiveItemUpdate> | undefined
  visible: number
}

/**
 * Per structural item array and start index. Rows re-render on every streamed
 * delta of their own item, but the rows after them only change structurally
 * with a new array, so the run is walked once per array and index; live text
 * after that is followed through the changed indices, never by listing the
 * whole live overlay.
 */
const blankRuns = new WeakMap<readonly Item[], Map<number, BlankRun>>()

function blankRun(items: readonly Item[], from: number): BlankRun {
  let runs = blankRuns.get(items)
  const known = runs?.get(from)
  if (known && known.length === items.length) return known
  let end = from
  while (end < items.length && isBlankReasoning(items[end]!)) end += 1
  const run: BlankRun = { end, length: items.length, live: undefined, visible: end }
  if (!runs) {
    runs = new Map()
    blankRuns.set(items, runs)
  }
  runs.set(from, run)
  return run
}

/**
 * The structural end of the blank reasoning run that starts at `from`: the
 * rows in between can only change visibility through live text.
 */
export function blankReasoningRunEnd(items: readonly Item[], from: number): number {
  return blankRun(items, from).end
}

/** The first item from `from` on that renders a row: blank reasoning shows nothing. */
export function nextItemWithARow(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  from: number,
): Item | undefined {
  const next = threadItemAt(items, liveItems, from)
  if (!next || !isBlankReasoning(next)) return next
  const run = blankRun(items, from)
  if (run.live !== liveItems) {
    const changed = run.live ? liveItemChangesSince(run.live, liveItems) : undefined
    if (changed) {
      for (const index of changed) {
        if (index < from || index > run.visible || index >= run.end) continue
        const shown = !isBlankReasoning(threadItemAt(items, liveItems, index)!)
        if (shown && index < run.visible) run.visible = index
        else if (!shown && index === run.visible) {
          run.visible = firstVisible(items, liveItems, from, run.end)
        }
      }
    } else {
      run.visible = firstVisible(items, liveItems, from, run.end)
    }
    run.live = liveItems
  }
  return threadItemAt(items, liveItems, run.visible)
}

function firstVisible(
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
  from: number,
  end: number,
): number {
  let index = from
  while (index < end && isBlankReasoning(threadItemAt(items, liveItems, index)!)) index += 1
  return index
}
