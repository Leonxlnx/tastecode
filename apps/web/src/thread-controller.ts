import type { ApprovalMode, DataOf, DomainEvent, QueuedTurn } from '@harness/contracts'
import type { Transport } from './transport.js'
import { ThreadFrameStore } from './thread-frame-store.js'
import {
  appendUserMessage,
  emptyThread,
  reduce,
  reduceEventLog,
  removeOptimisticMessage,
  type ThreadState,
} from './thread-store.js'
import {
  appendBackgroundThreadDelta,
  appendThreadDelta,
  drainPendingThreadDeltas,
  shouldDrainBackgroundDeltas,
  shouldRetainThreadTranscript,
  type PendingThreadDeltaBatch,
} from './thread-delta-buffer.js'
import {
  compactInactiveRunningThreadState,
  completePendingQueueRead,
  pruneInactiveQueueMetadata,
  pruneInactiveThreadStates,
  touchThreadState,
} from './thread-state-cache.js'
import { indexQueueItemIdsForChecks } from './workspace-idle.js'
import {
  NEW_CHAT_DRAFT_KEY,
  readComposerDraft,
  upsertComposerDraft,
  moveComposerDraft,
  type ComposerDraft,
} from './composer-drafts.js'

export type RecoverableDraft = { text: string; attachments: string[] }
export type PendingSubmission = RecoverableDraft & {
  id: string
  createdAt: number
  kind: 'turn' | 'queue' | 'steer'
  accepted: boolean
  indeterminate: boolean
  optimisticTurn?: NonNullable<ThreadState['activeTurn']>
  precedingTurnId?: string
}
type BufferedEvent = { seq: number | undefined; event: DomainEvent }
type QueueState = { items: QueuedTurn[]; canSteer: boolean }
const BACKGROUND_COMPACTION_CHECK_CHARACTERS = 64 * 1024

/** Owns transcript, replay, submission, queue and draft lifetimes. React reads
 * snapshots and issues commands; streaming updates publish through the frame store. */
export class ThreadController {
  readonly frames = new ThreadFrameStore(emptyThread)
  #states = new Map<string, ThreadState>()
  #sequences = new Map<string, number>()
  #submissions = new Map<string, Map<string, PendingSubmission>>()
  #drafts = new Map<string, ComposerDraft>()
  #histories = new Map<string, Set<BufferedEvent[]>>()
  #historyOwners = new Map<string, BufferedEvent[]>()
  #deltas = new Map<string, PendingThreadDeltaBatch>()
  #backgroundCharacters = new Map<string, number>()
  #queues = new Map<string, QueueState>()
  #localQueueRevisions = new Map<string, number>()
  #serverQueueRevisions = new Map<string, number>()
  #queueReads = new Map<string, number>()
  #recoveries = new Map<string, Set<object>>()
  #activeId: string | undefined
  #frame: number | undefined
  #recoveryRevision = 0
  #partialThreadIds = { has: (id: string) => !this.#sequences.has(id) }
  draftOwner = NEW_CHAT_DRAFT_KEY

  constructor(private transport: Transport) {}

  activate(id: string | undefined): void {
    this.#activeId = id
  }
  snapshot(id: string): ThreadState | undefined {
    return this.#states.get(id)
  }
  update(id: string, state: ThreadState): void {
    this.#states.set(id, state)
  }
  discardSnapshot(id: string): void {
    this.#states.delete(id)
  }
  cursor(id: string): number | undefined {
    return this.#sequences.get(id)
  }
  setCursor(id: string, sequence: number): void {
    this.#sequences.set(id, sequence)
  }
  touch(id: string): ThreadState | undefined {
    return touchThreadState(this.#states, id)
  }
  invalidateHistory(id: string): void {
    this.#sequences.delete(id)
    this.#historyOwners.delete(id)
  }
  resetBackground(id: string): void {
    this.#backgroundCharacters.delete(id)
  }
  pendingThreadIds(): IterableIterator<string> {
    return this.#submissions.keys()
  }
  hasPending(id: string): boolean {
    return this.#submissions.has(id)
  }
  submission(id: string, submissionId: string): Readonly<PendingSubmission> | undefined {
    return this.#submissions.get(id)?.get(submissionId)
  }
  updateSubmission(
    id: string,
    submissionId: string,
    updates: Partial<Pick<PendingSubmission, 'accepted' | 'indeterminate' | 'kind'>>,
  ): void {
    const current = this.submission(id, submissionId)
    if (current) this.#submissions.get(id)!.set(submissionId, { ...current, ...updates })
  }
  submit(id: string, submission: PendingSubmission): void {
    const pending = this.#submissions.get(id) ?? new Map()
    pending.set(submission.id, submission)
    this.#submissions.set(id, pending)
  }
  forgetSubmission(id: string, submissionId: string): void {
    const pending = this.#submissions.get(id)
    pending?.delete(submissionId)
    if (pending?.size === 0) this.#submissions.delete(id)
  }
  draft(key: string): ComposerDraft {
    return readComposerDraft(this.#drafts, key)
  }
  editDraft(key: string, patch: Partial<ComposerDraft>): ComposerDraft {
    return upsertComposerDraft(this.#drafts, key, patch)
  }
  forgetDraft(key: string): void {
    this.#drafts.delete(key)
  }
  moveDraft(from: string, to: string): void {
    moveComposerDraft(this.#drafts, from, to)
  }
  recoverDraft(id: string, rejected: RecoverableDraft): ComposerDraft {
    const current = this.#drafts.get(id)
    return this.editDraft(id, {
      text: current ? current.text + '\n\n' + rejected.text : rejected.text,
      attachments: [...new Set([...(current?.attachments ?? []), ...rejected.attachments])],
    })
  }
  get queues(): ReadonlyMap<string, QueueState> {
    return this.#queues
  }
  queue(id: string): QueueState | undefined {
    return this.#queues.get(id)
  }
  setQueue(id: string, state: QueueState, source: 'local' | 'server' | 'read' = 'read'): void {
    this.#queues.set(id, state)
    if (source !== 'read') {
      const revisions = source === 'local' ? this.#localQueueRevisions : this.#serverQueueRevisions
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
    }
  }
  queueRevision(id: string, source: 'local' | 'server'): number {
    return (
      (source === 'local' ? this.#localQueueRevisions : this.#serverQueueRevisions).get(id) ?? 0
    )
  }
  beginQueueRead(id: string): void {
    this.#queueReads.set(id, (this.#queueReads.get(id) ?? 0) + 1)
  }
  finishQueueRead(id: string): boolean {
    return completePendingQueueRead(this.#queueReads, id)
  }
  beginRecovery(): number {
    return ++this.#recoveryRevision
  }
  isCurrentRecovery(revision: number): boolean {
    return revision === this.#recoveryRevision
  }

  async recoverThread(
    id: string,
    revision: number,
    isProtected: (id: string) => boolean,
    retry = true,
  ): Promise<
    { history: ThreadState | undefined; state: QueueState; previousItems: QueuedTurn[] } | undefined
  > {
    const owner = {}
    const owners = this.#recoveries.get(id) ?? new Set<object>()
    owners.add(owner)
    this.#recoveries.set(id, owners)
    const history = this.loadHistory(id, this.cursor(id))
      .then((loaded) => loaded?.authority)
      .catch(() => undefined)
      .finally(() => this.prune(isProtected))
    this.beginQueueRead(id)
    const localRevision = this.queueRevision(id, 'local')
    const serverRevision = this.queueRevision(id, 'server')
    try {
      const state = await this.transport.request('thread.queue', { threadId: id })
      const loaded = await history
      if (!this.isCurrentRecovery(revision) || this.#recoveries.get(id) !== owners) return
      if (
        this.queueRevision(id, 'local') !== localRevision ||
        this.queueRevision(id, 'server') !== serverRevision
      ) {
        return retry ? this.recoverThread(id, revision, isProtected, false) : undefined
      }
      const previousItems = this.queue(id)?.items ?? []
      this.setQueue(id, state)
      return { history: loaded, state, previousItems }
    } catch {
      return undefined
    } finally {
      owners.delete(owner)
      if (this.#recoveries.get(id) === owners) {
        if (owners.size === 0) this.#recoveries.delete(id)
        if (this.finishQueueRead(id)) this.pruneQueues(isProtected)
      }
    }
  }

  isProtected(id: string): boolean {
    const state = this.snapshot(id)
    return (
      this.hasPending(id) ||
      this.#deltas.has(id) ||
      this.#histories.has(id) ||
      this.#historyOwners.has(id) ||
      (this.queue(id)?.items.length ?? 0) > 0 ||
      (state?.approvals.length ?? 0) > 0 ||
      (state?.userInputs.length ?? 0) > 0
    )
  }
  prune(isProtected: (id: string) => boolean): void {
    for (const id of this.#deltas.keys())
      if (id !== this.#activeId) this.flush(id, () => isProtected(id))
    pruneInactiveThreadStates(this.#states, this.#sequences, {
      activeId: this.#activeId,
      isProtected,
      isPartial: (id) => !this.#sequences.has(id),
      onCompact: (id) => this.#backgroundCharacters.delete(id),
    })
  }
  pruneQueues(isProtected: (id: string) => boolean): void {
    pruneInactiveQueueMetadata(
      this.#queues,
      this.#localQueueRevisions,
      this.#serverQueueRevisions,
      this.#queueReads,
      { activeId: this.#activeId, isProtected },
    )
  }
  compact(id: string, protectedState: boolean): void {
    compactInactiveRunningThreadState(this.#states, this.#sequences, id, {
      activeId: this.#activeId,
      protected: protectedState,
    })
  }
  forget(id: string): void {
    this.#states.delete(id)
    this.#sequences.delete(id)
    this.#submissions.delete(id)
    this.#deltas.delete(id)
    this.#backgroundCharacters.delete(id)
    this.#historyOwners.delete(id)
    this.#histories.delete(id)
    this.#queues.delete(id)
    this.#localQueueRevisions.delete(id)
    this.#serverQueueRevisions.delete(id)
    this.#queueReads.delete(id)
    this.#recoveries.delete(id)
  }
  flush(id: string, protectedState: () => boolean = () => this.isProtected(id)): ThreadState {
    const pending = this.#deltas.get(id)
    const current = this.snapshot(id) ?? emptyThread
    if (!pending?.events.length) return current
    const next = drainPendingThreadDeltas(this.#states, this.#deltas, this.#sequences, id)
    if (id !== this.#activeId) {
      const characters = (this.#backgroundCharacters.get(id) ?? 0) + pending.textLength
      if (characters >= BACKGROUND_COMPACTION_CHECK_CHARACTERS) {
        const compacted = compactInactiveRunningThreadState(this.#states, this.#sequences, id, {
          activeId: this.#activeId,
          protected: protectedState(),
        })
        if (compacted) {
          this.#backgroundCharacters.delete(id)
          return this.snapshot(id) ?? next
        }
      }
      this.#backgroundCharacters.set(id, characters % BACKGROUND_COMPACTION_CHECK_CHARACTERS)
    }
    return next
  }
  receive(
    { threadId: id, event, seq }: DataOf<'thread.event'>,
    isProtected: (id: string) => boolean,
  ): ThreadState | undefined {
    const sequence = this.cursor(id)
    const pending = this.#deltas.get(id)
    if (
      seq !== undefined &&
      sequence !== undefined &&
      seq <= Math.max(sequence, pending?.sequence ?? sequence)
    )
      return
    if (seq === undefined) this.#sequences.delete(id)
    const buffers = this.#histories.get(id)
    if (buffers) for (const buffer of buffers) buffer.push({ seq, event })
    if (event.type === 'item.delta') {
      if (!shouldRetainThreadTranscript(id, this.#activeId, this.#partialThreadIds)) {
        this.#deltas.delete(id)
        return
      }
      const cursor = seq !== undefined && sequence !== undefined ? seq : undefined
      const next =
        id === this.#activeId
          ? appendThreadDelta(pending, event, cursor)
          : appendBackgroundThreadDelta(pending, event, cursor)
      this.#deltas.set(id, next)
      if (id === this.#activeId) {
        this.#frame ??= requestAnimationFrame(() => {
          this.#frame = undefined
          if (this.#activeId) this.frames.publish(this.flush(this.#activeId))
        })
      } else if (shouldDrainBackgroundDeltas(next)) this.flush(id, () => isProtected(id))
      return
    }
    const next = reduce(
      this.flush(id, () => isProtected(id)),
      event,
    )
    this.update(id, next)
    if (seq !== undefined && sequence !== undefined) this.setCursor(id, Math.max(sequence, seq))
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      event.item.role === 'user'
    )
      this.forgetSubmission(id, event.item.id)
    if (id === this.#activeId) {
      if (this.#frame !== undefined) cancelAnimationFrame(this.#frame)
      this.#frame = undefined
      this.frames.publish(next)
    }
    return next
  }
  suspend(): void {
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame)
    this.#frame = undefined
    for (const id of this.#deltas.keys()) this.flush(id)
    this.beginRecovery()
    this.#historyOwners.clear()
  }
  async loadHistory(
    id: string,
    afterSeq?: number,
  ): Promise<
    | { visible: ThreadState; authority: ThreadState; approval?: ApprovalMode | undefined }
    | undefined
  > {
    if (afterSeq === undefined) this.#sequences.delete(id)
    const buffer: BufferedEvent[] = []
    const buffers = this.#histories.get(id) ?? new Set()
    buffers.add(buffer)
    this.#histories.set(id, buffers)
    this.#historyOwners.set(id, buffer)
    const base = afterSeq === undefined ? emptyThread : (this.snapshot(id) ?? emptyThread)
    try {
      const { events, running, approval } = await this.transport.request(
        'thread.history',
        afterSeq === undefined ? { threadId: id } : { threadId: id, afterSeq },
      )
      if (this.#historyOwners.get(id) !== buffer) return
      const restored = reduceEventLog(base, events, afterSeq)
      const lastSeq = events.at(-1)?.seq ?? afterSeq ?? 0
      const live = reduceEventLog(
        { ...restored, running, activeTurn: running ? restored.activeTurn : undefined },
        buffer,
        lastSeq,
      )
      if (buffer.some((entry) => entry.seq === undefined)) this.#sequences.delete(id)
      else
        this.setCursor(
          id,
          buffer.reduce((latest, entry) => Math.max(latest, entry.seq ?? latest), lastSeq),
        )
      const visible = this.#preserveSubmissions(id, live)
      this.#deltas.delete(id)
      this.update(id, visible)
      if (id === this.#activeId) this.frames.publish(visible)
      if (afterSeq === undefined) return { visible, authority: live, approval }
      const suffix = reduceEventLog(reduceEventLog(emptyThread, events), buffer, lastSeq)
      const crossedBoundary = [...events, ...buffer].some(
        ({ event }) => event.type === 'turn.started' || event.type === 'turn.completed',
      )
      return {
        visible,
        authority: { ...live, activeTurn: crossedBoundary ? suffix.activeTurn : live.activeTurn },
        approval,
      }
    } finally {
      buffers.delete(buffer)
      if (buffers.size === 0 && this.#histories.get(id) === buffers) this.#histories.delete(id)
      if (this.#historyOwners.get(id) === buffer) this.#historyOwners.delete(id)
    }
  }
  settleSubmissions(id: string, items: QueuedTurn[], snapshot?: ThreadState): PendingSubmission[] {
    const pending = this.#submissions.get(id)
    if (!pending) return []
    const queuedIds = indexQueueItemIdsForChecks(items, pending.size * 2)
    const queued = (key: string) => queuedIds?.has(key) ?? items.some((item) => item.id === key)
    let next = this.snapshot(id) ?? emptyThread
    const rejected: PendingSubmission[] = []
    for (const submission of pending.values()) {
      const durable = next.items.some((item) => item.id === submission.id && item.turnId !== '')
      if (durable || queued(submission.id)) {
        pending.delete(submission.id)
        if (queued(submission.id) && submission.kind !== 'queue')
          next = removePendingSubmission(next, submission)
      } else if (
        submission.indeterminate &&
        !submission.accepted &&
        snapshot !== undefined &&
        (!snapshot.running ||
          (submission.kind !== 'turn' &&
            snapshot.activeTurn?.id !== undefined &&
            snapshot.activeTurn.id === submission.precedingTurnId))
      ) {
        pending.delete(submission.id)
        next = removePendingSubmission(next, submission)
        rejected.push(submission)
      }
    }
    if (pending.size === 0) this.#submissions.delete(id)
    this.update(id, next)
    return rejected
  }
  #preserveSubmissions(id: string, state: ThreadState): ThreadState {
    const pending = this.#submissions.get(id)
    if (!pending) return state
    let next = state
    for (const submission of pending.values()) {
      const existing = next.items.find((item) => item.id === submission.id)
      if (existing) {
        if (existing.turnId !== '') pending.delete(submission.id)
        continue
      }
      if (submission.kind === 'queue') continue
      next = appendUserMessage(
        next,
        submission.text,
        submission.id,
        submission.createdAt,
        submission.attachments,
      )
      if (!next.running && submission.optimisticTurn)
        next = { ...next, running: true, activeTurn: submission.optimisticTurn }
    }
    if (pending.size === 0) this.#submissions.delete(id)
    return next
  }
}

export function removePendingSubmission(
  state: ThreadState,
  submission: PendingSubmission,
): ThreadState {
  const next = removeOptimisticMessage(state, submission.id)
  return submission.optimisticTurn && next.activeTurn?.id === submission.optimisticTurn.id
    ? { ...next, running: false, activeTurn: undefined }
    : next
}
