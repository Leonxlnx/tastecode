import type { Item } from '@harness/contracts'
import type { TurnTiming } from '../thread-state.js'

export type { TurnTiming } from '../thread-state.js'

const EMPTY_TURN_TIMING: TurnTiming = {}
const projectionCache = new WeakMap<Item[], WeakMap<TurnTiming, ThreadProjection>>()

/**
 * Turn boundaries within the flat item list.
 *
 * The thread stays one virtualised list — grouping into nested containers
 * would cost the flat index that virtualisation depends on. Instead we compute
 * where each turn starts and navigate by those indices.
 */

export type TurnMark = {
  turnId: string
  /** Index of the first item of the turn. */
  index: number
  /** How many items belong to it. */
  count: number
}

export type TurnActivityGroup = {
  /** Work updates and tool activity shown in one disclosure for a completed turn. */
  items: Item[]
  /** Flat-list index where Thread anchors this disclosure. */
  firstIndex: number
  lastIndex: number
  /** Total elapsed time for the completed turn. */
  elapsedMs: number
}

export type TurnPresentation = {
  /** One disclosure when complete; chronological batches while work is live. */
  activityGroups: TurnActivityGroup[]
  responseText: string
  firstResponseIndex: number | undefined
  finalAnswerIndex: number | undefined
  elapsedMs: number
  /** The current work interval restarts whenever the agent emits a message. */
  workStartedAt: number
  prompt: Item | undefined
  complete: boolean
  /** Turns carrying a design:* phase marker tell their story through the
   *  phase labels; raw provider activity stays out of the transcript. */
  design: boolean
}

export type ThreadProjection = {
  turns: TurnMark[]
  presentations: ReadonlyMap<string, TurnPresentation>
}

/** Activity groups are ordered, non-overlapping ranges. A binary lookup keeps
 *  each virtual row independent of how many tool batches came before it. */
export function activityGroupAt(
  groups: readonly TurnActivityGroup[],
  itemIndex: number,
): TurnActivityGroup | undefined {
  let low = 0
  let high = groups.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const group = groups[middle]
    if (!group) return undefined
    if (itemIndex < group.firstIndex) high = middle - 1
    else if (itemIndex > group.lastIndex) low = middle + 1
    else return group
  }
  return undefined
}

/**
 * Retains transcript-wide layout metadata while only the live answer's text
 * changes. The reducer replaces exactly one item per event and preserves every
 * other item identity, so an unchanged penultimate item proves the normal
 * streamed-tail path without walking the transcript. A history replacement or
 * an out-of-order update misses that proof and takes the full, safe rebuild.
 */
export function createThreadProjector(): (
  items: Item[],
  turnTiming?: TurnTiming,
) => ThreadProjection {
  let previousItems: Item[] | undefined
  let previousTurnTiming: TurnTiming | undefined
  let previousProjection: ThreadProjection | undefined

  return (items, turnTiming = EMPTY_TURN_TIMING) => {
    if (items === previousItems && turnTiming === previousTurnTiming && previousProjection) {
      return previousProjection
    }

    const cached = projectionCache.get(items)?.get(turnTiming)
    if (cached) {
      previousItems = items
      previousTurnTiming = turnTiming
      previousProjection = cached
      return cached
    }

    if (
      previousItems &&
      previousProjection &&
      turnTiming === previousTurnTiming &&
      isStartedAssistantTailTextUpdate(previousItems, items)
    ) {
      previousItems = items
      cacheThreadProjection(items, turnTiming, previousProjection)
      return previousProjection
    }

    if (previousItems && previousProjection && turnTiming === previousTurnTiming) {
      const tailStart = retainedTailStart(previousItems, items, previousProjection)
      if (tailStart !== undefined) {
        const tail = projectThreadRange(items, turnTiming, tailStart)
        const presentations = new Map(previousProjection.presentations)
        for (const turn of previousProjection.turns) {
          if (turn.index >= tailStart) presentations.delete(turn.turnId)
        }
        for (const [turnId, presentation] of tail.presentations) {
          presentations.set(turnId, presentation)
        }
        previousItems = items
        previousProjection = {
          turns: [
            ...previousProjection.turns.filter((turn) => turn.index < tailStart),
            ...tail.turns,
          ],
          presentations,
        }
        cacheThreadProjection(items, turnTiming, previousProjection)
        return previousProjection
      }
    }

    previousItems = items
    previousTurnTiming = turnTiming
    previousProjection = projectThreadItems(items, turnTiming)
    cacheThreadProjection(items, turnTiming, previousProjection)
    return previousProjection
  }
}

function cacheThreadProjection(
  items: Item[],
  turnTiming: TurnTiming,
  projection: ThreadProjection,
): void {
  let byTiming = projectionCache.get(items)
  if (!byTiming) {
    byTiming = new WeakMap()
    projectionCache.set(items, byTiming)
  }
  byTiming.set(turnTiming, projection)
}

export function projectThreadItems(
  items: Item[],
  turnTiming: TurnTiming = EMPTY_TURN_TIMING,
): ThreadProjection {
  return projectThreadRange(items, turnTiming, 0)
}

function projectThreadRange(
  items: Item[],
  turnTiming: TurnTiming,
  startIndex: number,
): ThreadProjection {
  const turns: TurnMark[] = []
  return {
    turns,
    presentations: presentTurnsRange(items, turnTiming, startIndex, items.length, turns),
  }
}

/**
 * The compact, completed-turn view used by first-party agent apps.
 *
 * The provider may emit commentary before its final answer. Completed
 * commentary folds into the same disclosure as tool activity, while the final
 * answer stays readable. Live tool activity stays in chronological batches so
 * the current batch can update in place. Empty reasoning placeholders are
 * invisible and do not split a live batch. An explicit final-answer phase
 * wins; older unphased histories safely fall back to their last completed
 * assistant message.
 */
function presentTurnsRange(
  items: Item[],
  turnTiming: TurnTiming,
  startIndex: number,
  endIndex: number,
  turns?: TurnMark[],
): ReadonlyMap<string, TurnPresentation> {
  const drafts = new Map<
    string,
    {
      activityGroups: Array<{
        entries: Array<{ item: Item; index: number }>
        lastIndex: number
        startedAt: number
        startsTurn: boolean
        completedAt?: number
      }>
      workEntries: Array<{ item: Item; index: number }>
      answers: Array<{ item: Item; index: number }>
      prompt?: Item
      firstResponseIndex?: number
      earliest: number
      latest: number
      latestOutputAt?: number
      latestAssistantOutputAt?: number
      hasRunningActivity: boolean
      activityCount: number
      onlyReasoning: boolean
      design: boolean
    }
  >()

  for (let index = startIndex; index < endIndex; index += 1) {
    const item = items[index]!
    if (turns) {
      const turnId = normalizedTurnId(item, index)
      const last = turns.at(-1)
      if (last?.turnId === turnId) last.count += 1
      else turns.push({ turnId, index, count: 1 })
    }
    if (!item.turnId) continue

    let draft = drafts.get(item.turnId)
    if (!draft) {
      draft = {
        activityGroups: [],
        workEntries: [],
        answers: [],
        earliest: item.createdAt,
        latest: item.createdAt,
        hasRunningActivity: false,
        activityCount: 0,
        onlyReasoning: true,
        design: false,
      }
      drafts.set(item.turnId, draft)
    }

    draft.earliest = Math.min(draft.earliest, item.createdAt)
    draft.latest = Math.max(draft.latest, item.createdAt)
    draft.design ||= item.type === 'tool_call' && item.text?.startsWith('design:') === true

    if ((item.type !== 'message' || item.role !== 'user') && !isBlankReasoning(item)) {
      draft.firstResponseIndex ??= index
    }

    if (isActivity(item)) {
      draft.activityCount += 1
      draft.onlyReasoning &&= item.type === 'reasoning'
      draft.hasRunningActivity ||= item.status === 'started'
    }

    if (isStackedActivity(item)) {
      draft.workEntries.push({ item, index })
      const lastGroup = draft.activityGroups.at(-1)
      if (lastGroup?.lastIndex === index - 1) {
        lastGroup.entries.push({ item, index })
        lastGroup.lastIndex = index
      } else {
        draft.activityGroups.push({
          entries: [{ item, index }],
          lastIndex: index,
          startedAt: draft.latestOutputAt ?? item.createdAt,
          startsTurn: draft.latestAssistantOutputAt === undefined,
        })
      }
    } else if (isBlankReasoning(item)) {
      // Empty provider reasoning has no readable transcript content. Keep an
      // open tool batch anchored in one place while the next command arrives,
      // and include the placeholder in its compacted flat-list range.
      const openGroup = draft.activityGroups.at(-1)
      if (openGroup && openGroup.completedAt === undefined) openGroup.lastIndex = index
    } else {
      const openGroup = draft.activityGroups.at(-1)
      if (openGroup && openGroup.completedAt === undefined) openGroup.completedAt = item.createdAt
      draft.latestOutputAt = item.createdAt

      if (item.type === 'message' && item.role === 'user') draft.prompt ??= item
      if (item.type === 'message' && item.role === 'assistant') {
        draft.latestAssistantOutputAt = item.createdAt
        if (item.status === 'completed') {
          draft.answers.push({ item, index })
          draft.workEntries.push({ item, index })
        }
      }
    }
  }

  const presentations = new Map<string, TurnPresentation>()
  for (const [turnId, draft] of drafts) {
    const finalAnswer =
      draft.answers.findLast(({ item }) => item.phase === 'final_answer') ??
      draft.answers.findLast(({ item }) => isLegacyFinalAnswer(item))
    const timing = turnTiming[turnId]
    const elapsedMs =
      timing?.startedAt !== undefined && timing.completedAt !== undefined
        ? Math.max(0, timing.completedAt - timing.startedAt)
        : Math.max(0, draft.latest - draft.earliest)
    const complete =
      !draft.hasRunningActivity &&
      (finalAnswer !== undefined || (draft.activityCount > 1 && draft.onlyReasoning))
    const liveActivityGroups = draft.activityGroups.map(
      ({ entries, lastIndex, startedAt, startsTurn, completedAt }) => ({
        items: entries.map(({ item }) => item),
        firstIndex: entries[0]!.index,
        lastIndex,
        elapsedMs: Math.max(
          0,
          (completedAt ?? timing?.completedAt ?? draft.latest) -
            (startsTurn ? (timing?.startedAt ?? startedAt) : startedAt),
        ),
      }),
    )
    const completedWork = draft.workEntries.filter(({ index }) => index !== finalAnswer?.index)
    const activityGroups =
      complete && completedWork.length > 0
        ? [
            {
              items: completedWork.map(({ item }) => item),
              firstIndex: completedWork[0]!.index,
              lastIndex: completedWork.at(-1)!.index,
              elapsedMs,
            },
          ]
        : liveActivityGroups

    presentations.set(turnId, {
      activityGroups,
      responseText: finalAnswer?.item.text ?? '',
      firstResponseIndex: draft.firstResponseIndex,
      finalAnswerIndex: finalAnswer?.index,
      elapsedMs,
      workStartedAt: draft.latestAssistantOutputAt ?? timing?.startedAt ?? draft.earliest,
      prompt: draft.prompt,
      complete,
      design: draft.design,
    })
  }
  return presentations
}

function retainedTailStart(
  previous: Item[],
  next: Item[],
  projection: ThreadProjection,
): number | undefined {
  if (next.length === previous.length + 1) {
    if (previous.length > 0 && previous.at(-1) !== next[previous.length - 1]) return undefined
    const appendedIndex = previous.length
    const appendedTurn = normalizedTurnId(next[appendedIndex]!, appendedIndex)
    const previousTurn = projection.turns.at(-1)
    return previousTurn?.turnId === appendedTurn ? previousTurn.index : appendedIndex
  }

  if (next.length !== previous.length || next.length === 0) return undefined
  const lastIndex = next.length - 1
  if (previous[lastIndex] === next[lastIndex]) return undefined
  if (lastIndex > 0 && previous[lastIndex - 1] !== next[lastIndex - 1]) return undefined
  return projection.turns.at(-1)?.index ?? 0
}

function normalizedTurnId(item: Item, index: number): string {
  return item.turnId === '' ? `local:${index}` : item.turnId
}

function isLegacyFinalAnswer(item: Item): boolean {
  // Design progress notes predate structured assistant phases. They are
  // narration, not terminal answers, so old saved threads must not give each
  // note its own response actions. Terminal Design messages use another id.
  return item.phase === undefined && !item.id.startsWith('design-note-')
}

function isStartedAssistantTailTextUpdate(previous: Item[], next: Item[]): boolean {
  if (previous.length === 0 || previous.length !== next.length) return false

  const index = next.length - 1
  if (index > 0 && previous[index - 1] !== next[index - 1]) return false

  const before = previous[index]
  const after = next[index]
  return (
    before !== after &&
    before?.type === 'message' &&
    before.role === 'assistant' &&
    before.status === 'started' &&
    after?.type === before.type &&
    after.role === before.role &&
    after.phase === before.phase &&
    after.status === before.status &&
    after.id === before.id &&
    after.turnId === before.turnId &&
    after.createdAt === before.createdAt &&
    after.command === before.command &&
    after.exitCode === before.exitCode &&
    after.durationMs === before.durationMs &&
    after.path === before.path &&
    after.linesAdded === before.linesAdded &&
    after.linesRemoved === before.linesRemoved &&
    after.text !== before.text
  )
}

function isActivity(item: Item): boolean {
  return item.type !== 'message' && item.type !== 'error'
}

export function isStackedActivity(item: Item): boolean {
  return (
    item.type === 'command' ||
    item.type === 'file_change' ||
    item.type === 'tool_call' ||
    item.type === 'plan'
  )
}

export function isBlankReasoning(item: Item): boolean {
  return item.type === 'reasoning' && !item.text?.trim()
}

/**
 * The turn to jump to from the current scroll position.
 *
 * Going back from inside a turn returns to that turn's own start first, which
 * is what "previous" means while reading — one press should not skip the thing
 * you are looking at.
 */
export function neighbourTurn(
  turns: TurnMark[],
  currentIndex: number,
  direction: 'prev' | 'next',
): number | undefined {
  if (turns.length === 0) return undefined

  let low = 0
  let high = turns.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (turns[middle]!.index < currentIndex) low = middle + 1
    else high = middle
  }

  if (direction === 'prev') return turns[low - 1]?.index
  const next = turns[low]
  return next?.index === currentIndex ? turns[low + 1]?.index : next?.index
}
