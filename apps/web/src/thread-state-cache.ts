import { releaseThreadItemIndex, type ThreadState } from './thread-store.js'
import { turnTimingKeys } from './turn-timing-change.js'

export const MAX_INACTIVE_THREAD_STATES = 3
export const MAX_INACTIVE_THREAD_ITEMS = 3_000
export const MAX_INACTIVE_THREAD_CHARACTERS = 8 * 1024 * 1024
const MAX_SINGLE_BACKGROUND_RUNNING_ITEMS = 256
const MAX_SINGLE_BACKGROUND_RUNNING_CHARACTERS = 256 * 1024
export const MAX_BACKGROUND_RUNNING_STATES = 8
export const MAX_BACKGROUND_RUNNING_ITEMS = 512
export const MAX_BACKGROUND_RUNNING_CHARACTERS = 512 * 1024

/**
 * Finish one queue read and report when the whole concurrent read batch has
 * drained. Metadata pruning is global, so running it before the last read
 * turns a reconnect with many active threads into a quadratic scan.
 */
export function completePendingQueueRead(
  pendingReads: Map<string, number>,
  threadId: string,
): boolean {
  const remaining = (pendingReads.get(threadId) ?? 1) - 1
  if (remaining > 0) pendingReads.set(threadId, remaining)
  else pendingReads.delete(threadId)
  return pendingReads.size === 0
}

export function pruneInactiveQueueMetadata<T extends { items: readonly unknown[] }>(
  queues: Map<string, T>,
  localRevisions: Map<string, number>,
  serverRevisions: Map<string, number>,
  pendingReads: ReadonlyMap<string, number>,
  options: {
    activeId?: string | undefined
    protectedIds?: ReadonlySet<string> | undefined
    isProtected?: ((threadId: string) => boolean) | undefined
  } = {},
): string[] {
  const evicted: string[] = []
  const prune = (id: string) => {
    if (
      id === options.activeId ||
      (queues.get(id)?.items.length ?? 0) > 0 ||
      (pendingReads.get(id) ?? 0) > 0 ||
      options.protectedIds?.has(id) ||
      options.isProtected?.(id)
    )
      return
    queues.delete(id)
    localRevisions.delete(id)
    serverRevisions.delete(id)
    evicted.push(id)
  }

  // Deleting the current Map entry is iteration-safe. Later maps skip IDs
  // still owned by an earlier map, so each retained ID is checked once and an
  // evicted ID disappears before the later pass reaches it.
  for (const id of queues.keys()) prune(id)
  for (const id of localRevisions.keys()) if (!queues.has(id)) prune(id)
  for (const id of serverRevisions.keys()) if (!queues.has(id) && !localRevisions.has(id)) prune(id)
  return evicted
}

export function touchThreadState(
  states: Map<string, ThreadState>,
  threadId: string,
): ThreadState | undefined {
  const state = states.get(threadId)
  if (!state) return undefined
  // Map iteration order is the LRU order. Reinsert only on session selection;
  // streamed updates to a background thread must not make it look recently read.
  states.delete(threadId)
  states.set(threadId, state)
  return state
}

/**
 * Bound complete inactive histories while retaining anything that still has
 * live or unsaved work. The durable cursor leaves with an evicted history so
 * selecting it later performs one safe full reload instead of extending a
 * missing prefix.
 */
export function pruneInactiveThreadStates(
  states: Map<string, ThreadState>,
  durableSequences: Map<string, number>,
  options: {
    activeId?: string | undefined
    protectedIds?: ReadonlySet<string> | undefined
    isProtected?: ((threadId: string) => boolean) | undefined
    isPartial?: ((threadId: string) => boolean) | undefined
    onCompact?: ((threadId: string) => void) | undefined
    maxInactiveStates?: number | undefined
    maxInactiveItems?: number | undefined
    maxInactiveCharacters?: number | undefined
    maxBackgroundRunningStates?: number | undefined
    maxBackgroundRunningItems?: number | undefined
    maxBackgroundRunningCharacters?: number | undefined
  } = {},
): string[] {
  const candidates: Array<{
    id: string
    state: ThreadState
    itemCount: number
    characters: number
  }> = []
  const runningCandidates: Array<{
    id: string
    state: ThreadState
    itemCount: number
    characters: number
    exceedsSingleBudget: boolean
  }> = []
  let itemCount = 0
  let runningStateCount = 0
  let runningItemCount = 0
  let runningCharacters = 0

  for (const [id, state] of states) {
    if (id === options.activeId || options.protectedIds?.has(id) || options.isProtected?.(id))
      continue
    if (state.running) {
      if (options.isPartial?.(id)) continue
      const usage = runningTranscriptUsage(state)
      runningCandidates.push({
        id,
        state,
        ...usage,
        exceedsSingleBudget:
          usage.itemCount > MAX_SINGLE_BACKGROUND_RUNNING_ITEMS ||
          usage.characters > MAX_SINGLE_BACKGROUND_RUNNING_CHARACTERS,
      })
      runningStateCount += 1
      runningItemCount += usage.itemCount
      runningCharacters += usage.characters
      continue
    }
    releaseThreadItemIndex(state.items)
    const entry = { id, state, itemCount: state.items.length, characters: 0 }
    candidates.push(entry)
    itemCount += entry.itemCount
  }

  const maxStates = options.maxInactiveStates ?? MAX_INACTIVE_THREAD_STATES
  const maxItems = options.maxInactiveItems ?? MAX_INACTIVE_THREAD_ITEMS
  const maxCharacters = options.maxInactiveCharacters ?? MAX_INACTIVE_THREAD_CHARACTERS
  const maxRunningStates = options.maxBackgroundRunningStates ?? MAX_BACKGROUND_RUNNING_STATES
  const maxRunningItems = options.maxBackgroundRunningItems ?? MAX_BACKGROUND_RUNNING_ITEMS
  const maxRunningCharacters =
    options.maxBackgroundRunningCharacters ?? MAX_BACKGROUND_RUNNING_CHARACTERS
  for (const candidate of runningCandidates) {
    if (
      !candidate.exceedsSingleBudget &&
      runningStateCount <= maxRunningStates &&
      runningItemCount <= maxRunningItems &&
      runningCharacters <= maxRunningCharacters
    ) {
      continue
    }
    states.set(candidate.id, compactRunningTranscript(candidate.state))
    durableSequences.delete(candidate.id)
    runningStateCount -= 1
    runningItemCount -= candidate.itemCount
    runningCharacters -= candidate.characters
    options.onCompact?.(candidate.id)
  }

  const evicted: string[] = []
  let candidateIndex = 0
  const evictCandidate = () => {
    const candidate = candidates[candidateIndex]
    if (!candidate) return false
    candidateIndex += 1
    itemCount -= candidate.itemCount
    states.delete(candidate.id)
    durableSequences.delete(candidate.id)
    evicted.push(candidate.id)
    return true
  }
  while (candidates.length - candidateIndex > maxStates || itemCount > maxItems) {
    if (!evictCandidate()) break
  }

  // Item and state limits leave at most three histories / 3,000 rows to scan.
  // Count only that retained LRU suffix, so visiting 100 old long threads does
  // not turn byte accounting into a second full-history walk.
  let characterCount = 0
  for (let index = candidateIndex; index < candidates.length; index += 1) {
    const candidate = candidates[index]!
    candidate.characters = inactiveThreadCharacters(candidate.state)
    characterCount += candidate.characters
  }
  while (characterCount > maxCharacters) {
    const candidate = candidates[candidateIndex]
    if (!candidate) break
    characterCount -= candidate.characters
    if (!evictCandidate()) break
  }

  return evicted
}

/** Release a large background transcript as soon as its optimistic send has settled. */
export function compactInactiveRunningThreadState(
  states: Map<string, ThreadState>,
  durableSequences: Map<string, number>,
  threadId: string,
  options: { activeId?: string | undefined; protected?: boolean | undefined } = {},
): boolean {
  if (threadId === options.activeId || options.protected) return false
  const state = states.get(threadId)
  if (!state?.running || !runningTranscriptExceedsBudget(state)) return false
  states.set(threadId, compactRunningTranscript(state))
  // The retained lifecycle is intentionally incomplete. A later selection
  // must fetch one full authoritative replay before showing the thread.
  durableSequences.delete(threadId)
  return true
}

function runningTranscriptExceedsBudget(state: ThreadState): boolean {
  const usage = runningTranscriptUsage(state)
  return (
    usage.itemCount > MAX_SINGLE_BACKGROUND_RUNNING_ITEMS ||
    usage.characters > MAX_SINGLE_BACKGROUND_RUNNING_CHARACTERS
  )
}

type RunningTranscriptUsage = { itemCount: number; characters: number }

function runningTranscriptUsage(state: ThreadState): RunningTranscriptUsage {
  if (state.items.length > MAX_SINGLE_BACKGROUND_RUNNING_ITEMS) {
    return { itemCount: state.items.length, characters: 0 }
  }

  let characters = 0
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.liveItems.get(index)?.item ?? state.items[index]
    if (!item) continue
    characters += itemCharacters(item)
    if (characters > MAX_SINGLE_BACKGROUND_RUNNING_CHARACTERS) {
      return { itemCount: state.items.length, characters }
    }
  }
  return { itemCount: state.items.length, characters }
}

function inactiveThreadCharacters(state: ThreadState): number {
  let characters = 0
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.liveItems.get(index)?.item ?? state.items[index]
    if (item) characters += itemCharacters(item)
  }
  characters += state.activeTurn?.id.length ?? 0
  for (const turnId of turnTimingKeys(state.turnTiming)) characters += turnId.length
  for (const step of state.plan) characters += step.text.length
  characters += state.usage?.model?.length ?? 0
  characters += state.diff?.length ?? 0
  characters += state.diffTurnId?.length ?? 0
  for (const approval of state.approvals) {
    characters += approval.id.length
    characters += approval.reason?.length ?? 0
    characters += approval.command?.length ?? 0
    characters += approval.cwd?.length ?? 0
    characters += approval.path?.length ?? 0
  }
  for (const request of state.userInputs) {
    characters += request.id.length + request.turnId.length
    for (const question of request.questions) {
      characters += question.id.length + question.header.length + question.question.length
      for (const option of question.options ?? []) {
        characters += option.label.length + option.description.length
      }
    }
  }
  for (const [reviewId, review] of Object.entries(state.reviews)) {
    characters += reviewId.length + review.id.length + review.turnId.length
    characters += review.description.length + (review.rationale?.length ?? 0)
  }
  return characters
}

function itemCharacters(item: ThreadState['items'][number]): number {
  let characters = item.id.length + item.turnId.length
  characters += item.text?.length ?? 0
  characters += item.command?.length ?? 0
  characters += item.path?.length ?? 0
  for (const attachment of item.attachments ?? []) characters += attachment.length
  return characters
}

/** Retain lifecycle and blocking state; the durable log owns the released transcript. */
function compactRunningTranscript(state: ThreadState): ThreadState {
  const activeTurnId = state.activeTurn?.id
  const activeTiming = activeTurnId ? state.turnTiming[activeTurnId] : undefined
  return {
    ...state,
    items: [],
    liveItems: new Map(),
    liveStart: 0,
    turnTiming: activeTurnId && activeTiming ? { [activeTurnId]: activeTiming } : {},
  }
}
