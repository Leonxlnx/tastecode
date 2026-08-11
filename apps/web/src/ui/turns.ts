import type { Item } from '@harness/contracts'

export type TurnTiming = Readonly<Record<string, { startedAt?: number; completedAt?: number }>>

const EMPTY_TURN_TIMING: TurnTiming = {}

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
  /** Consecutive operational items between two transcript messages. */
  items: Item[]
  /** Flat-list index where Thread anchors this disclosure. */
  firstIndex: number
}

export type TurnPresentation = {
  /** Chronological Worked disclosures, split wherever narration resumes. */
  activityGroups: TurnActivityGroup[]
  responseText: string
  firstResponseIndex: number | undefined
  finalAnswerIndex: number | undefined
  elapsedMs: number
  complete: boolean
  /** Turns carrying a design:* phase marker tell their story through the
   *  phase labels; raw provider activity stays out of the transcript. */
  design: boolean
}

export type ThreadProjection = {
  turns: TurnMark[]
  presentations: ReadonlyMap<string, TurnPresentation>
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

    if (
      previousItems &&
      previousProjection &&
      turnTiming === previousTurnTiming &&
      isStartedAssistantTailTextUpdate(previousItems, items)
    ) {
      previousItems = items
      return previousProjection
    }

    previousItems = items
    previousTurnTiming = turnTiming
    previousProjection = {
      turns: findTurns(items),
      presentations: presentTurns(items, turnTiming),
    }
    return previousProjection
  }
}

export function findTurns(items: Item[]): TurnMark[] {
  const turns: TurnMark[] = []

  items.forEach((item, index) => {
    // The optimistic user echo has no turn id yet; it still starts a turn
    // visually, so it gets its own boundary rather than joining the last one.
    const turnId = item.turnId === '' ? `local:${index}` : item.turnId
    const last = turns[turns.length - 1]
    if (last && last.turnId === turnId) {
      last.count += 1
      return
    }
    turns.push({ turnId, index, count: 1 })
  })

  return turns
}

/**
 * The compact, completed-turn view used by first-party agent apps.
 *
 * The provider may emit commentary messages before its final answer. Those
 * messages stay in the transcript, so operational items are compacted only in
 * contiguous groups between them. An explicit final-answer phase wins; older
 * unphased histories safely fall back to their last completed assistant message.
 */
export function presentTurns(
  items: Item[],
  turnTiming: TurnTiming = EMPTY_TURN_TIMING,
): ReadonlyMap<string, TurnPresentation> {
  const drafts = new Map<
    string,
    {
      activityGroups: Array<{
        entries: Array<{ item: Item; index: number }>
        lastIndex: number
      }>
      answers: Array<{ item: Item; index: number }>
      firstResponseIndex?: number
      earliest: number
      latest: number
      hasRunningActivity: boolean
      design: boolean
    }
  >()

  items.forEach((item, index) => {
    if (!item.turnId) return

    const draft = drafts.get(item.turnId) ?? {
      activityGroups: [],
      answers: [],
      earliest: item.createdAt,
      latest: item.createdAt,
      hasRunningActivity: false,
      design: false,
    }

    draft.earliest = Math.min(draft.earliest, item.createdAt)
    draft.latest = Math.max(draft.latest, item.createdAt)
    draft.design ||= item.type === 'tool_call' && item.text?.startsWith('design:') === true

    if (item.type !== 'message' || item.role !== 'user') {
      draft.firstResponseIndex ??= index
    }

    if (isActivity(item)) {
      const lastGroup = draft.activityGroups.at(-1)
      if (lastGroup?.lastIndex === index - 1) {
        lastGroup.entries.push({ item, index })
        lastGroup.lastIndex = index
      } else {
        draft.activityGroups.push({ entries: [{ item, index }], lastIndex: index })
      }
      draft.hasRunningActivity ||= item.status === 'started'
    } else if (
      item.type === 'message' &&
      item.role === 'assistant' &&
      item.status === 'completed'
    ) {
      draft.answers.push({ item, index })
    }

    drafts.set(item.turnId, draft)
  })

  return new Map(
    [...drafts].map(([turnId, draft]) => {
      const finalAnswer =
        draft.answers.findLast(({ item }) => item.phase === 'final_answer') ??
        draft.answers.findLast(({ item }) => item.phase === undefined)
      const timing = turnTiming[turnId]

      return [
        turnId,
        {
          activityGroups: draft.activityGroups.map(({ entries }) => ({
            items: entries.map(({ item }) => item),
            firstIndex: entries[0]!.index,
          })),
          responseText: finalAnswer?.item.text ?? '',
          firstResponseIndex: draft.firstResponseIndex,
          finalAnswerIndex: finalAnswer?.index,
          elapsedMs:
            timing?.startedAt !== undefined && timing.completedAt !== undefined
              ? Math.max(0, timing.completedAt - timing.startedAt)
              : Math.max(0, draft.latest - draft.earliest),
          complete: finalAnswer !== undefined && !draft.hasRunningActivity,
          design: draft.design,
        },
      ]
    }),
  )
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

  if (direction === 'next') {
    return turns.find((turn) => turn.index > currentIndex)?.index
  }

  const before = turns.filter((turn) => turn.index < currentIndex)
  return before[before.length - 1]?.index
}
