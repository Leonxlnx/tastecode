import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { ApprovalDecision, Item } from '@harness/contracts'
import { ThinkingOrb } from 'thinking-orbs'
import {
  IconArrowBarToDown as ArrowDownToLine,
  IconBook2 as BookOpen,
  IconBrain as Brain,
  IconCheck as Check,
  IconChevronRight as ChevronRight,
  IconAlertCircle as CircleAlert,
  IconHelpCircle as CircleQuestionMark,
  IconCopy as Copy,
  IconFilePencil as FilePenLine,
  IconLibraryPhoto as Images,
  IconListCheck as ListChecks,
  IconLoader2 as LoaderCircle,
  IconPalette as Palette,
  IconPencil as Pencil,
  IconRotate as RotateCcw,
  IconSearch as Search,
  IconTerminal2 as SquareTerminal,
  IconTool as Wrench,
} from '@tabler/icons-react'
import {
  previewViewedImage,
  revealPath,
  writeClipboardText,
  type PickedAttachment,
} from '../bridge.js'
import { isEditableTarget } from '../shortcuts.js'
import type { Transport } from '../transport.js'
import { Approval } from './Approval.js'
import { Diff } from './Diff.js'
import { IconMorph } from './IconMorph.js'
import { LazyMediaViewer as MediaViewer, preloadMediaViewer } from './LazyMediaViewer.js'
import { Markdown } from './Markdown.js'
import { Plan } from './Plan.js'
import { ThreadSkeleton } from './Skeleton.js'
import {
  activityGroupAt,
  createThreadProjector,
  isBlankReasoning,
  isStackedActivity,
  neighbourTurn,
  type TurnActivityGroup,
  type TurnPresentation,
} from './turns.js'
import {
  activeTurnAnchor,
  isAtBottom,
  modeForNewTurn,
  shouldReleaseAnchor,
  type ScrollMode,
} from './scroll-mode.js'
import { useVirtualItemKey } from './use-virtual-item-key.js'
import { UserInput } from '../design-agent/UserInput.js'
import type { Checkpoint } from './RollbackDialog.js'
import {
  activeTurnActivityIndices,
  activeTurnIsSearching,
  threadItemAt,
  type LiveItemUpdate,
} from '../thread-store.js'
import type { ThreadFrameStore } from '../thread-frame-store.js'
import {
  checkpointForItem,
  createCheckpointIndex,
  type CheckpointIndex,
} from '../checkpoint-index.js'
import { enteringThreadItems } from '../thread-entry.js'
import '../styles/thread.css'

const ThreadSearch = lazy(() =>
  import('./ThreadSearch.js').then((module) => ({ default: module.ThreadSearch })),
)

const EMPTY_LIVE_ITEMS: ReadonlyMap<number, LiveItemUpdate> = new Map()
const EMPTY_CHECKPOINTS: readonly Checkpoint[] = []

/**
 * The thread.
 *
 * Virtualised: only the rows near the viewport exist in the DOM, so a session
 * with hundreds of turns costs the same as one with five. Rows are measured
 * rather than estimated because a single item can be three words or a 400-line
 * diff, and a wrong estimate shows up as scroll drift.
 *
 * Messages read as prose. Reasoning stays collapsed under a timed Thought
 * row you can open. Commands, tool calls and file edits in one work batch
 * share one line. The default view should read as a summary of what happened,
 * not a transcript of every byte.
 */
export interface ThreadProps {
  errorsInComposer?: boolean
  frameStore: ThreadFrameStore
  loading?: boolean
  projectPath?: string | undefined
  stopping?: boolean | undefined
  threadId?: string | undefined
  transport?: Transport | undefined
  searchJump?: { turnId: string; request: number } | undefined
  revealRequest?: number | undefined
  checkpoints?: Checkpoint[] | undefined
  keyboardActive?: boolean | undefined
  onEditMessage?: ((text: string) => void) | undefined
  onRevertCheckpoint?: ((checkpoint: Checkpoint) => void) | undefined
  onUndoChanges?:
    ((threadId: string, turnId: string, expectedDiff: string) => Promise<void>) | undefined
  onDecide: (id: string, decision: ApprovalDecision) => void
  onAnswerUserInput: (id: string, answers: Record<string, string[]>) => void | Promise<void>
}

export const Thread = memo(function Thread(props: ThreadProps) {
  const thread = useSyncExternalStore(
    props.frameStore.subscribeStructure,
    props.frameStore.getStructureSnapshot,
    props.frameStore.getStructureSnapshot,
  )
  const running = thread.running && !props.stopping
  const activeActivityIndices = useMemo(
    () => activeTurnActivityIndices(thread.items, thread.activeTurn?.id, thread.liveStart),
    [thread.items, thread.activeTurn?.id, thread.liveStart],
  )
  const currentApproval = thread.approvals[0]
  const scroller = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ScrollMode>('follow-end')
  const [finding, setFinding] = useState(false)
  const completedSearchJump = useRef(0)
  const completedRevealRequest = useRef(props.revealRequest ?? 0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** Index the current turn starts at, for anchor mode. */
  const anchorIndex = useRef(0)
  const activeAnchor = useMemo(
    () => activeTurnAnchor(thread.items, thread.activeTurn?.id, thread.liveStart),
    [thread.items, thread.activeTurn?.id, thread.liveStart],
  )
  const anchoredTurn = useRef({ threadId: props.threadId, itemId: activeAnchor?.id })
  /**
   * Our own scrollTop writes fire scroll events too. Without telling them
   * apart from the user's, the handler cannot let a manual scroll take over
   * during anchor mode — the effect would just yank the viewport back on the
   * next streamed chunk, which is the most hostile thing a chat UI can do.
   *
   * We track the position we last wrote, rather than a one-shot flag: the browser may
   * coalesce two of our writes into a single scroll event, and a leftover
   * flag would then swallow the user's next real gesture. Comparing positions
   * cannot get out of step that way.
   */
  const writtenScrollTop = useRef<number | undefined>(undefined)
  const writeScrollTop = useCallback((el: HTMLElement, top: number) => {
    // Clamp before comparing: an out-of-range target gets clamped by the
    // browser, so the write would land somewhere we did not record.
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const target = Math.min(Math.max(top, 0), max)
    if (Math.abs(el.scrollTop - target) < 1) return
    writtenScrollTop.current = target
    el.scrollTop = target
  }, [])
  const liveItems = thread.liveItems
  const enteringItemIds = useEnteringItemIds(thread.items, props.threadId)
  const settledTurnId = useSettledTurnId(running, thread.activeTurn?.id)
  const getItemKey = useVirtualItemKey(thread.items, props.threadId)

  const virtualizer = useVirtualizer({
    count: thread.items.length,
    getScrollElement: () => scroller.current,
    // Roughly one paragraph. Wrong estimates only cost a correction on measure.
    estimateSize: () => 72,
    // Stable identity per item, never the index — index keys make every
    // insertion look like a change to every row after it.
    getItemKey,
    overscan: 8,
    // Assume a viewport for the very first render, before measurement has run.
    // Without it the first frame contains no rows at all, which reads as a
    // blank thread for one frame when switching sessions.
    initialRect: { width: 720, height: 800 },
  })

  // A turn starting is the one moment the reading position should change.
  // Watch its first item rather than the running boolean: a queued turn can
  // start in the same render batch that the previous turn completes, leaving
  // `running` true throughout. The submission id also survives the local ->
  // durable handoff, so provider confirmation does not cause a second jump.
  useEffect(() => {
    if (anchoredTurn.current.threadId !== props.threadId) {
      anchoredTurn.current = { threadId: props.threadId, itemId: activeAnchor?.id }
      return
    }
    if (!running) {
      anchoredTurn.current.itemId = undefined
      return
    }
    if (!activeAnchor || anchoredTurn.current.itemId === activeAnchor.id) return

    anchoredTurn.current.itemId = activeAnchor.id
    anchorIndex.current = activeAnchor.index
    const el = scroller.current
    setMode(modeForNewTurn(el ? isAtBottom(el) : true))
  }, [running, props.threadId, activeAnchor])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    // Our own corrections are not the user's opinion. The event that lands
    // where we wrote is ours; anything else is a real gesture.
    if (
      writtenScrollTop.current !== undefined &&
      Math.abs(el.scrollTop - writtenScrollTop.current) < 1
    ) {
      writtenScrollTop.current = undefined
      return
    }
    writtenScrollTop.current = undefined
    // Any manual move away from the exact end hands control back at once.
    // isAtBottom intentionally has 80px of slack for starting a new turn,
    // but that slack must not trap small upward gestures during streaming.
    const nextMode = el.scrollHeight - el.scrollTop - el.clientHeight <= 1 ? 'follow-end' : 'free'
    if (modeRef.current !== nextMode) {
      // Update the ref before the next streamed chunk can run the layout
      // effect and pull the viewport back to the end.
      modeRef.current = nextMode
      setMode(nextMode)
    }
  }, [])

  // Ctrl+F cannot work with a virtualised list — the match may not be in the
  // DOM — so the app owns find instead of the browser.
  useEffect(() => {
    if (props.keyboardActive === false) return
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      // Plain Ctrl+F only — Ctrl+Shift+F belongs to the global chat search,
      // and swallowing it here killed that shortcut whenever a thread was
      // open.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        setFinding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.keyboardActive])

  const jumpTo = useCallback(
    (index: number) => {
      setMode('free')
      virtualizer.scrollToIndex(index, { align: 'center' })
    },
    [virtualizer],
  )

  const projectThread = useMemo(createThreadProjector, [props.threadId])
  const { turns, presentations } = projectThread(thread.items, thread.turnTiming)
  const projectRepeatedDesignRows = useMemo(createRepeatedDesignRowProjector, [props.threadId])
  const repeatedDesignRowAt = projectRepeatedDesignRows(thread.items)
  const checkpoints = thread.running ? EMPTY_CHECKPOINTS : (props.checkpoints ?? EMPTY_CHECKPOINTS)
  const checkpointIndex = useMemo(() => createCheckpointIndex(checkpoints), [checkpoints])
  const activePresentation = thread.activeTurn ? presentations.get(thread.activeTurn.id) : undefined
  useEffect(() => {
    const target = props.searchJump
    if (!target || completedSearchJump.current === target.request) return
    const index = thread.items.findIndex((item) => item.turnId === target.turnId)
    if (index < 0) return
    completedSearchJump.current = target.request
    setFinding(false)
    setMode('free')
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [thread.items, props.searchJump, virtualizer])

  // Alt+Up/Down moves a turn at a time. Scrolling by pixel through a long
  // session to find where an exchange began is the slow way to do it.
  useEffect(() => {
    if (props.keyboardActive === false) return
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      // The first VISIBLE row, not rows[0] — that one is up to `overscan`
      // items above the viewport, and navigating from it could send the user
      // backwards to a turn they had already scrolled past.
      const rows = virtualizer.getVirtualItems()
      const scrollTop = scroller.current?.scrollTop ?? 0
      const current = (rows.find((row) => row.end > scrollTop) ?? rows[0])?.index ?? 0
      const target = neighbourTurn(turns, current, event.key === 'ArrowUp' ? 'prev' : 'next')
      if (target === undefined) return
      event.preventDefault()
      setMode('free')
      virtualizer.scrollToIndex(target, { align: 'start' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.keyboardActive, turns, virtualizer])

  const rows = virtualizer.getVirtualItems()

  // The generic rail only covers the gap before the first response, plus
  // design turns whose phase owns the status line. Normal reasoning, tool
  // activity and answer text carry their own visible state in chronological
  // rows, so the rail must disappear instead of duplicating them.
  //
  // measurementsCache, not getOffsetForIndex: the latter clamps to the
  // maximum scroll offset, which is below the anchor row's true start
  // whenever the thread is shorter than the viewport.
  const showWorkingRail =
    running &&
    thread.activeTurn !== undefined &&
    (activePresentation?.design === true || activePresentation?.firstResponseIndex === undefined)
  const railIndex = showWorkingRail ? activePresentation?.firstResponseIndex : undefined
  const railOffset =
    railIndex === undefined
      ? virtualizer.getTotalSize()
      : (virtualizer.measurementsCache[railIndex]?.start ?? virtualizer.getTotalSize())

  return (
    // The overlays live OUTSIDE the scroller: an absolutely positioned child
    // of a scroll container scrolls away with the content — Ctrl+F used to
    // yank the transcript to the top just to show the find bar, and "Jump to
    // latest" rendered below the viewport exactly when it was needed.
    <div className="thread-shell">
      <FrameScrollFollower
        frameStore={props.frameStore}
        revealRequest={props.revealRequest ?? 0}
        completedRevealRequest={completedRevealRequest}
        scroller={scroller}
        modeRef={modeRef}
        anchorIndex={anchorIndex}
        virtualizer={virtualizer}
        writeScrollTop={writeScrollTop}
        setMode={setMode}
      />
      {finding ? (
        <Suspense fallback={null}>
          <ThreadSearch
            items={thread.items}
            liveItems={liveItems}
            frameStore={props.frameStore}
            threadId={props.threadId}
            onJump={jumpTo}
            onClose={() => setFinding(false)}
          />
        </Suspense>
      ) : null}
      {thread.items.length === 0 && !running ? (
        props.loading ? (
          <ThreadSkeleton className="thread__empty" />
        ) : (
          <div className="empty thread__empty">
            <div className="empty__prompt" role="heading" aria-level={1}>
              Tell the agent what you want to build, then send it below.
            </div>
          </div>
        )
      ) : null}
      <div className="thread" ref={scroller} onScroll={onScroll}>
        <div className="thread__col">
          <div className="thread__runway" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const item = threadItemAt(thread.items, liveItems, row.index)
              if (!item) return null
              const presentation = presentations.get(item.turnId)
              const activityGroup =
                presentation && presentation.design !== true
                  ? activityGroupAt(presentation.activityGroups, row.index)
                  : undefined
              return (
                <ThreadFrameRow
                  key={row.key}
                  index={row.index}
                  start={row.start}
                  measureElement={virtualizer.measureElement}
                  frameStore={props.frameStore}
                  items={thread.items}
                  presentation={presentation}
                  activityGroup={activityGroup}
                  running={running}
                  errorsInComposer={props.errorsInComposer ?? false}
                  activeTurnId={thread.activeTurn?.id}
                  repeatedDesignRowAt={repeatedDesignRowAt}
                  entering={enteringItemIds.has(item.id)}
                  settlingTurnId={settledTurnId}
                  showWorkingRail={showWorkingRail}
                  projectPath={props.projectPath}
                  onEditMessage={props.onEditMessage}
                  checkpointIndex={checkpointIndex}
                  onRevertCheckpoint={props.onRevertCheckpoint}
                />
              )
            })}
            {showWorkingRail && thread.activeTurn ? (
              // Deliberately not keyed by turn id: the optimistic turn's id is
              // replaced by the server's a few seconds in, and a key would
              // remount the rail at exactly the moment this render position
              // exists to survive. Before any response row exists the rail
              // sits at the end of the runway, over the space the spacer
              // below holds.
              <div className="thread__rail" style={{ transform: `translateY(${railOffset}px)` }}>
                <FrameWorkingRail
                  frameStore={props.frameStore}
                  items={thread.items}
                  turnId={thread.activeTurn.id}
                  liveStart={thread.liveStart}
                  activityIndices={activeActivityIndices}
                  startedAt={activePresentation?.workStartedAt ?? thread.activeTurn.startedAt}
                />
              </div>
            ) : null}
          </div>

          {showWorkingRail && thread.activeTurn && railIndex === undefined ? (
            <div className="thread__rail-spacer" aria-hidden />
          ) : null}

          {/* Above the plan and the diff: it is the only thing here that blocks
            the agent, so it should be the first thing the eye lands on. */}
          {thread.userInputs.map((request) => (
            <UserInput
              key={request.id}
              request={request}
              onSubmit={(answers) => props.onAnswerUserInput(request.id, answers)}
            />
          ))}

          {currentApproval ? (
            <Approval
              key={currentApproval.id}
              request={currentApproval}
              onDecide={(decision) => props.onDecide(currentApproval.id, decision)}
            />
          ) : null}

          {running ? <Plan steps={thread.plan} compact /> : null}
          {!running ? (
            <Diff
              diff={thread.diff}
              threadId={props.threadId}
              transport={props.transport}
              onUndo={
                props.threadId && thread.diffTurnId && thread.diff && props.onUndoChanges
                  ? () => props.onUndoChanges!(props.threadId!, thread.diffTurnId!, thread.diff!)
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>

      {mode === 'free' ? (
        <button
          className="jump"
          onClick={() => {
            const el = scroller.current
            if (!el) return
            // Stay in free mode for the whole glide. Flipping to follow-end
            // here unmounts the button, and the first mid-flight scroll event
            // then flips it straight back — remounting it with its entrance
            // animation — until the scroll lands. The onScroll handler hands
            // over to follow-end once the glide actually reaches the bottom.
            el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: 'smooth' })
            // Already at the bottom? Nothing animates and no scroll event
            // comes, so there would be no handover — hide right away.
            if (isAtBottom(el)) setMode('follow-end')
          }}
        >
          <ArrowDownToLine size={13} aria-hidden />
          Jump to latest
        </button>
      ) : null}
    </div>
  )
})

/**
 * Follow-scroll needs every text frame, but the virtual list does not. Keep
 * that small imperative update in its own subscriber so growing one live row
 * never rerenders the transcript owner or reprojects the full thread.
 */
function FrameScrollFollower({
  frameStore,
  revealRequest,
  completedRevealRequest,
  scroller,
  modeRef,
  anchorIndex,
  virtualizer,
  writeScrollTop,
  setMode,
}: {
  frameStore: ThreadFrameStore
  revealRequest: number
  completedRevealRequest: { current: number }
  scroller: { current: HTMLDivElement | null }
  modeRef: { current: ScrollMode }
  anchorIndex: { current: number }
  virtualizer: Virtualizer<HTMLDivElement, Element>
  writeScrollTop: (element: HTMLElement, top: number) => void
  setMode: (mode: ScrollMode) => void
}) {
  const getVersion = useCallback(() => frameStore.getSnapshot().itemVersion, [frameStore])
  const itemVersion = useSyncExternalStore(frameStore.subscribe, getVersion, getVersion)

  // Layout effect, not effect: this runs before paint, so the correction is
  // never visible as a jump.
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return

    if (completedRevealRequest.current !== revealRequest) {
      completedRevealRequest.current = revealRequest
      modeRef.current = 'follow-end'
      setMode('follow-end')
      writeScrollTop(element, element.scrollHeight - element.clientHeight)
      return
    }

    if (modeRef.current === 'follow-end') {
      writeScrollTop(element, element.scrollHeight - element.clientHeight)
      return
    }

    if (modeRef.current === 'anchor-turn') {
      const start = virtualizer.getOffsetForIndex(anchorIndex.current, 'start')?.[0]
      if (start === undefined) return
      const turnHeight = virtualizer.getTotalSize() - start
      if (shouldReleaseAnchor(turnHeight, element.clientHeight)) {
        setMode('follow-end')
        return
      }
      writeScrollTop(element, start)
    }
  }, [
    anchorIndex,
    completedRevealRequest,
    itemVersion,
    modeRef,
    revealRequest,
    scroller,
    setMode,
    virtualizer,
    writeScrollTop,
  ])

  return null
}

const ITEM_ENTRY_MS = 360
const TURN_SETTLE_MS = 520

function useFrameLiveItems(
  frameStore: ThreadFrameStore,
  indices: readonly number[],
): ReadonlyMap<number, LiveItemUpdate> {
  const subscribe = useCallback(
    (listener: () => void) => frameStore.subscribeItems(indices, listener),
    [frameStore, indices],
  )
  const getVersion = useCallback(() => frameStore.getSnapshot().itemVersion, [frameStore])
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return frameStore.getSnapshot().liveItems
}

function useFrameLiveItemRange(
  frameStore: ThreadFrameStore,
  firstIndex: number,
  lastIndex: number,
): ReadonlyMap<number, LiveItemUpdate> {
  const subscribe = useCallback(
    (listener: () => void) => {
      return firstIndex === lastIndex
        ? frameStore.subscribeItems([firstIndex], listener)
        : frameStore.subscribeItemRange(firstIndex, lastIndex, listener)
    },
    [firstIndex, frameStore, lastIndex],
  )
  const getVersion = useCallback(() => frameStore.getSnapshot().itemVersion, [frameStore])
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return frameStore.getSnapshot().liveItems
}

const ThreadFrameRow = memo(function ThreadFrameRow({
  index,
  start,
  measureElement,
  frameStore,
  items,
  presentation,
  activityGroup,
  running,
  errorsInComposer,
  activeTurnId,
  repeatedDesignRowAt,
  entering,
  settlingTurnId,
  showWorkingRail,
  projectPath,
  onEditMessage,
  checkpointIndex,
  onRevertCheckpoint,
}: {
  index: number
  start: number
  measureElement: (node: Element | null) => void
  frameStore: ThreadFrameStore
  items: Item[]
  presentation: TurnPresentation | undefined
  activityGroup: TurnActivityGroup | undefined
  running: boolean
  errorsInComposer: boolean
  activeTurnId: string | undefined
  repeatedDesignRowAt: (item: Item, index: number) => boolean
  entering: boolean
  settlingTurnId: string | undefined
  showWorkingRail: boolean
  projectPath: string | undefined
  onEditMessage: ((text: string) => void) | undefined
  checkpointIndex: CheckpointIndex<Checkpoint>
  onRevertCheckpoint: ((checkpoint: Checkpoint) => void) | undefined
}) {
  const firstSubscribedIndex = activityGroup?.firstIndex ?? index
  const lastSubscribedIndex = activityGroup?.lastIndex ?? index
  const liveItems = useFrameLiveItemRange(frameStore, firstSubscribedIndex, lastSubscribedIndex)
  const item = threadItemAt(items, liveItems, index)
  if (!item) return null

  const live = running && activeTurnId === item.turnId
  const compactedActivity =
    activityGroup !== undefined &&
    (isStackedActivity(item) ||
      (presentation?.complete === true &&
        item.type === 'message' &&
        item.role === 'assistant' &&
        index !== presentation.finalAnswerIndex))
  const activityLead = compactedActivity && activityGroup.firstIndex === index
  const itemAfterActivity = activityGroup
    ? threadItemAt(items, liveItems, activityGroup.lastIndex + 1)
    : undefined
  const liveActivityGroup =
    live &&
    activityGroup !== undefined &&
    (itemAfterActivity === undefined || itemAfterActivity.turnId !== item.turnId)
  const responseLead =
    !live && presentation?.complete === true && presentation.finalAnswerIndex === index
  const suppressed =
    (errorsInComposer && item.type === 'error') ||
    isBlankReasoning(item) ||
    (compactedActivity && !activityLead) ||
    repeatedDesignRowAt(item, index)
  const nextVisibleItem = threadItemAt(
    items,
    liveItems,
    activityLead && activityGroup ? activityGroup.lastIndex + 1 : index + 1,
  )
  const compactToNext =
    !suppressed &&
    nextVisibleItem?.turnId === item.turnId &&
    !(item.type === 'message' && item.role === 'user') &&
    !(nextVisibleItem.type === 'message' && nextVisibleItem.role === 'user')
  const settling = settlingTurnId === item.turnId
  const railAnchor = showWorkingRail && live && presentation?.firstResponseIndex === index
  const activitySource =
    activityLead && activityGroup ? { group: activityGroup, items, liveItems } : undefined
  const liveItemUpdate = liveItems.get(index)

  return (
    <div
      className={`thread__row${suppressed ? ' is-suppressed' : ''}${compactToNext ? ' is-compact-to-next' : ''}${entering ? ' is-entering' : ''}${settling ? ' is-settling' : ''}${railAnchor ? ' is-rail-anchor' : ''}`}
      data-index={index}
      ref={measureElement}
      style={{ transform: `translateY(${start}px)` }}
    >
      <Row
        item={item}
        liveTextUpdate={liveItemUpdate?.textUpdate}
        liveUpdateVersion={liveItemUpdate?.version}
        projectPath={projectPath}
        hidden={suppressed}
        activity={activitySource}
        activityLive={liveActivityGroup}
        live={live}
        responseText={responseLead ? presentation.responseText : undefined}
        finalResponse={responseLead}
        settling={settling}
        onEditMessage={onEditMessage}
        checkpoint={checkpointForItem(presentation?.prompt ?? item, checkpointIndex)}
        onRevertCheckpoint={onRevertCheckpoint}
      />
    </div>
  )
})

/**
 * Only animate items appended while this thread is open. Historical rows can
 * remount as virtualisation scrolls, and replaying their entrance then makes
 * the list feel unstable rather than alive.
 */
function useEnteringItemIds(items: Item[], threadId?: string): ReadonlySet<string> {
  const previousItems = useRef(items)
  const previousThreadId = useRef(threadId)
  const timers = useRef(new Map<string, number>())
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set())

  useLayoutEffect(() => {
    // Thread never remounts on session switch; comparing against another
    // session's items would replay the entry animation on historical rows.
    if (previousThreadId.current !== threadId) {
      previousThreadId.current = threadId
      previousItems.current = items
      setEntering((current) => (current.size === 0 ? current : new Set()))
      return
    }
    const previous = previousItems.current
    previousItems.current = items
    const incoming = enteringThreadItems(previous, items)

    if (incoming.length === 0) return

    setEntering((current) => {
      const next = new Set(current)
      for (const item of incoming) next.add(item.id)
      return next
    })

    for (const item of incoming) {
      const existingTimer = timers.current.get(item.id)
      if (existingTimer !== undefined) window.clearTimeout(existingTimer)
      timers.current.set(
        item.id,
        window.setTimeout(() => {
          timers.current.delete(item.id)
          setEntering((current) => {
            if (!current.has(item.id)) return current
            const next = new Set(current)
            next.delete(item.id)
            return next
          })
        }, ITEM_ENTRY_MS),
      )
    }
  }, [items])

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
    },
    [],
  )

  return entering
}

/** Keeps the final working-to-worked change animated for one short beat. */
function useSettledTurnId(running: boolean, activeTurnId: string | undefined): string | undefined {
  const lastActiveTurnId = useRef(activeTurnId)
  const wasRunning = useRef(running)
  const timer = useRef<number | undefined>(undefined)
  const [settledTurnId, setSettledTurnId] = useState<string>()

  useLayoutEffect(() => {
    const finishedTurnId = wasRunning.current && !running ? lastActiveTurnId.current : undefined
    if (activeTurnId) lastActiveTurnId.current = activeTurnId
    wasRunning.current = running
    if (!finishedTurnId) return

    setSettledTurnId(finishedTurnId)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setSettledTurnId((current) => (current === finishedTurnId ? undefined : current))
    }, TURN_SETTLE_MS)
  }, [activeTurnId, running])

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )

  return settledTurnId
}

function isActivity(item: Item): boolean {
  return item.type !== 'message' && item.type !== 'error'
}

const Row = memo(function Row({
  item,
  liveTextUpdate,
  liveUpdateVersion,
  projectPath,
  hidden,
  activity,
  activityLive,
  live,
  responseText,
  finalResponse,
  settling,
  onEditMessage,
  checkpoint,
  onRevertCheckpoint,
}: {
  item: Item
  liveTextUpdate: LiveItemUpdate['textUpdate'] | undefined
  liveUpdateVersion: number | undefined
  projectPath: string | undefined
  hidden: boolean
  activity: ActivityRenderSource | undefined
  activityLive: boolean
  live: boolean
  responseText: string | undefined
  finalResponse: boolean
  settling: boolean
  onEditMessage: ((text: string) => void) | undefined
  checkpoint: Checkpoint | undefined
  onRevertCheckpoint: ((checkpoint: Checkpoint) => void) | undefined
}) {
  if (hidden) return null

  // The working rail already announces the running design phase by name; a
  // second row with the same label reads as a duplicate. The row appears once
  // the phase completes, with its duration.
  if (item.type === 'tool_call' && item.status === 'started' && designPhaseLabel(toolText(item))) {
    return null
  }

  if (activity) {
    return (
      <ActivityStack
        activity={activity}
        live={activityLive}
        projectPath={projectPath}
        settling={settling}
      />
    )
  }

  // The user's own words get a surface so the eye can find where each exchange
  // begins; the agent's answer is plain prose, which is what you actually read.
  if (item.type === 'message' && item.role === 'user') {
    const imageAttachments = item.attachments?.filter(isImageAttachment) ?? []
    return (
      <div className="said">
        {imageAttachments.length > 0 ? (
          <div className="said__attachments" aria-label="Attached images">
            {imageAttachments.map((attachment) => (
              <ViewedImagePreview
                key={attachment}
                reference={attachment}
                active
                variant="message"
              />
            ))}
          </div>
        ) : null}
        {item.text ? <p className="said__text">{item.text}</p> : null}
        {item.text ? (
          <div className="response-actions said__actions" aria-label="Prompt actions">
            <CopyAction text={item.text} label="Copy prompt" />
            {onEditMessage ? (
              <button
                type="button"
                onClick={() => onEditMessage(item.text!)}
                aria-label="Edit prompt"
                title="Edit"
              >
                <Pencil aria-hidden />
              </button>
            ) : null}
            {checkpoint && onRevertCheckpoint ? (
              <button
                type="button"
                onClick={() => onRevertCheckpoint(checkpoint)}
                aria-label="Revert to before prompt"
                title="Revert"
              >
                <RotateCcw aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (item.type === 'message') {
    const text = responseText ?? item.text ?? ''
    return (
      <div className={`reply${live ? ' is-streaming' : ''}`}>
        <Markdown
          text={text}
          projectPath={projectPath}
          streaming={live && item.status === 'started'}
          liveUpdate={liveTextUpdate}
          updateVersion={liveUpdateVersion}
        />
        {finalResponse && !live && item.status === 'completed' && text ? (
          <ResponseActions
            text={text}
            createdAt={item.createdAt}
            checkpoint={checkpoint}
            onRevertCheckpoint={onRevertCheckpoint}
          />
        ) : null}
      </div>
    )
  }

  if (item.type === 'reasoning') {
    const text = item.text?.trim()
    if (!text) return null
    return (
      <ReasoningDisclosure
        item={item}
        text={text}
        live={live}
        projectPath={projectPath}
        liveTextUpdate={liveTextUpdate}
        liveUpdateVersion={liveUpdateVersion}
      />
    )
  }

  if (item.type === 'error') {
    return (
      <div className="turn-error">
        <CircleAlert className="turn-error__glyph" size={13} aria-hidden />
        <p className="turn-error__text">{item.text}</p>
      </div>
    )
  }

  return <AuxDisclosure item={item} live={live} />
})

function activityItemsForRender(
  group: TurnActivityGroup,
  items: readonly Item[],
  liveItems: ReadonlyMap<number, LiveItemUpdate>,
): Item[] {
  let containsLiveUpdate = false
  for (const index of liveItems.keys()) {
    if (index >= group.firstIndex && index <= group.lastIndex) {
      containsLiveUpdate = true
      break
    }
  }
  if (!containsLiveUpdate) return group.items

  const activity: Item[] = []
  for (let index = group.firstIndex; index <= group.lastIndex; index += 1) {
    const item = threadItemAt(items, liveItems, index)
    if (item && isWorkDisclosureItem(item)) activity.push(item)
  }
  return activity
}

type ActivityRenderSource = {
  group: TurnActivityGroup
  items: readonly Item[]
  liveItems: ReadonlyMap<number, LiveItemUpdate>
}

function lastActivityItemForRender({
  group,
  items,
  liveItems,
}: ActivityRenderSource): Item | undefined {
  for (let index = group.lastIndex; index >= group.firstIndex; index -= 1) {
    const item = threadItemAt(items, liveItems, index)
    if (item && isWorkDisclosureItem(item)) return item
  }
  return undefined
}

/**
 * A standalone operational row for activity that does not belong to a normal
 * tool stack, such as a design phase marker or an unknown provider item.
 */
function AuxDisclosure({ item, live }: { item: Item; live: boolean }) {
  const disclosure = useDisclosure()
  const detail =
    item.type === 'command' || item.type === 'tool_call' || item.type === 'file_change'
      ? activityDetail(item)
      : isContextCompaction(item)
        ? undefined
        : (imageViewDetail(item) ?? item.text)

  return (
    <div
      className={`aux aux--${item.type} ${live ? 'aux--live' : ''}`}
      data-expanded={disclosure.expanded}
    >
      <button
        type="button"
        className="aux__row"
        aria-expanded={disclosure.expanded}
        onClick={disclosure.toggle}
      >
        <span className="aux__glyph" aria-hidden>
          {glyph(item)}
        </span>
        <span className="aux__label">
          {live
            ? summariseLive(item)
            : item.type === 'command' || item.type === 'file_change'
              ? activityItemLabel(item)
              : summarise(item)}
        </span>
        {item.exitCode !== undefined && item.exitCode !== 0 ? (
          <span className="aux__code">exit {item.exitCode}</span>
        ) : null}
        {/* Only worth showing once it is long enough to have been noticed. */}
        {item.durationMs !== undefined && item.durationMs >= 1000 ? (
          <span className="aux__time">{duration(item.durationMs)}</span>
        ) : null}
        {!live && item.status === 'started' && !isImageView(item) ? (
          <LoaderCircle className="spinner" aria-hidden />
        ) : null}
      </button>
      {/* Design markers have no output worth expanding — their text is the slug. */}
      {detail && !(item.type === 'tool_call' && designPhaseLabel(toolText(item))) ? (
        <div
          className="aux__reveal"
          data-open={disclosure.dataOpen}
          aria-hidden={!disclosure.expanded}
          inert={!disclosure.expanded}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'clip-path')
              disclosure.finishClosing()
          }}
        >
          {disclosure.contentMounted ? (
            <div className="aux__reveal-clip">
              {isImageView(item) && item.status === 'completed' ? (
                <ViewedImagePreview
                  reference={detail}
                  active={disclosure.expanded}
                  fallbackClassName="aux__out"
                />
              ) : (
                <pre className="aux__out">{detail}</pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type DisclosurePhase = 'closed' | 'open' | 'closing'

function ReasoningDisclosure({
  item,
  text,
  live,
  projectPath,
  liveTextUpdate,
  liveUpdateVersion,
}: {
  item: Item
  text: string
  live: boolean
  projectPath: string | undefined
  liveTextUpdate: LiveItemUpdate['textUpdate'] | undefined
  liveUpdateVersion: number | undefined
}) {
  const disclosure = useDisclosure()
  const liveThinking = live && item.status === 'started'
  const labelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!liveThinking) return
    let timer: number | undefined
    const update = () => {
      if (labelRef.current) labelRef.current.textContent = liveThoughtLabel(item.createdAt)
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = undefined
      if (document.visibilityState === 'hidden') return
      update()
      const elapsed = Math.max(0, Date.now() - item.createdAt)
      if (item.createdAt <= 0 || elapsed > 86_400_000) return
      const period = elapsed >= 3_600_000 ? 60_000 : 1_000
      timer = window.setTimeout(schedule, Math.max(50, period - (elapsed % period)))
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [liveThinking, item.createdAt])

  return (
    <div
      className={`aux aux--reasoning ${live ? 'aux--live' : ''}`}
      data-expanded={disclosure.expanded}
    >
      <button
        type="button"
        className="aux__row"
        aria-expanded={disclosure.expanded}
        onClick={disclosure.toggle}
      >
        <span className="aux__glyph" aria-hidden>
          <Brain size={13} />
        </span>
        <span ref={labelRef} className="aux__label">
          {liveThinking ? liveThoughtLabel(item.createdAt) : thoughtLabel(item, false)}
        </span>
        <ChevronRight className="activity__chevron" size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div
        className="aux__reveal"
        data-open={disclosure.dataOpen}
        aria-hidden={!disclosure.expanded}
        inert={!disclosure.expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'clip-path')
            disclosure.finishClosing()
        }}
      >
        <div className="aux__reveal-clip">
          {disclosure.expanded || disclosure.dataOpen === 'closing' ? (
            <div className={`reasoning-summary${live ? ' is-live' : ''}`}>
              <Markdown
                text={text}
                projectPath={projectPath}
                streaming={live && item.status === 'started'}
                liveUpdate={liveTextUpdate}
                updateVersion={liveUpdateVersion}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function thoughtLabel(item: Item, live: boolean): string {
  if (live && item.status === 'started') return liveThoughtLabel(item.createdAt)
  if (item.durationMs === undefined || item.durationMs < 1000) return 'Thought'
  return `Thought for ${thoughtDuration(item.durationMs)}`
}

function liveThoughtLabel(startedAt: number): string {
  if (startedAt <= 0) return 'Thinking'
  const elapsed = Math.max(0, Date.now() - startedAt)
  if (elapsed < 1000 || elapsed > 86_400_000) return 'Thinking'
  return `Thought for ${thoughtDuration(elapsed)}`
}

function thoughtDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
}

function useDisclosure() {
  const [phase, setPhase] = useState<DisclosurePhase>('closed')
  const expanded = phase === 'open'

  useEffect(() => {
    if (phase !== 'closing') return
    // A reversal before the first paint can leave no transition to finish.
    const timer = window.setTimeout(
      () => setPhase((current) => (current === 'closing' ? 'closed' : current)),
      180,
    )
    return () => window.clearTimeout(timer)
  }, [phase])

  const toggle = useCallback(() => {
    const reduceMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    setPhase((current) => (current === 'open' ? (reduceMotion ? 'closed' : 'closing') : 'open'))
  }, [])

  const finishClosing = useCallback(() => {
    setPhase((current) => (current === 'closing' ? 'closed' : current))
  }, [])

  return {
    expanded,
    contentMounted: phase !== 'closed',
    dataOpen: phase === 'open' ? 'true' : phase === 'closing' ? 'closing' : 'false',
    toggle,
    finishClosing,
  } as const
}

function groupCommandRuns(items: Item[]): (Item | Item[])[] {
  if (items.every((item) => item.type === 'command')) return items
  const rows: (Item | Item[])[] = []
  for (const item of items) {
    const previous = rows.at(-1)
    if (item.type === 'command' && Array.isArray(previous)) {
      previous.push(item)
    } else if (
      item.type === 'command' &&
      !Array.isArray(previous) &&
      previous?.type === 'command'
    ) {
      rows[rows.length - 1] = [previous, item]
    } else {
      rows.push(item)
    }
  }
  return rows
}

function CommandRun({ items, live }: { items: Item[]; live: boolean }) {
  const disclosure = useDisclosure()
  const failed = items.filter(
    (item) => item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0),
  ).length
  const pending = items.some((item) => item.status === 'started')
  const label = `${live && pending ? 'Running commands' : 'Ran commands'}${failed ? ` (${failed} failed)` : ''}${!live && pending ? ' (interrupted)' : ''}`

  return (
    <div className="activity" data-expanded={disclosure.expanded}>
      <button
        type="button"
        className="activity__summary"
        aria-expanded={disclosure.expanded}
        onClick={disclosure.toggle}
      >
        <span className="activity__glyph" aria-hidden>
          {glyph(items[0]!)}
        </span>
        <span className="activity__label">{label}</span>
        <ChevronRight className="activity__chevron" size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div
        className="activity__reveal"
        data-open={disclosure.dataOpen}
        aria-hidden={!disclosure.expanded}
        inert={!disclosure.expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'clip-path')
            disclosure.finishClosing()
        }}
      >
        {disclosure.contentMounted ? (
          <div className="activity__reveal-clip">
            <div className="activity__body">
              {items.map((item) => (
                <AuxDisclosure key={item.id} item={item} live={live && item.status === 'started'} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ActivityStack({
  activity,
  live,
  projectPath,
  settling,
}: {
  activity: ActivityRenderSource
  live: boolean
  projectPath: string | undefined
  settling: boolean
}) {
  const disclosure = useDisclosure()
  const completedActivity = activity.group.items.filter(isWorkDisclosureItem)
  const operationalActivity = completedActivity.filter(isStackedActivity)
  const current = live
    ? lastActivityItemForRender(activity)
    : (operationalActivity.at(-1) ?? completedActivity.at(-1))
  const hasCommentary = completedActivity.some(
    (item) => item.type === 'message' && item.role === 'assistant',
  )
  const label =
    live && current
      ? liveActivityLabel(current)
      : hasCommentary
        ? `Worked for ${workedFor(activity.group.elapsedMs)}`
        : activityStackLabel(operationalActivity)
  const summaryItem = live ? current : (operationalActivity[0] ?? completedActivity[0])
  const summaryRef = useRef<HTMLButtonElement>(null)
  const summaryId = summaryItem?.id
  const previousSummaryId = useRef(summaryId)

  useLayoutEffect(() => {
    const previous = previousSummaryId.current
    previousSummaryId.current = summaryId
    const node = summaryRef.current
    // The row owns its first entrance. Only animate a new call in the reused stack.
    if (!live || !previous || previous === summaryId || !node?.animate) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const style = getComputedStyle(node)
    const animation = node.animate(
      [
        { opacity: 0, transform: reduced ? 'none' : 'translateY(5px)' },
        { opacity: 1, transform: reduced ? 'none' : 'translateY(0)' },
      ],
      {
        duration: Number.parseFloat(style.getPropertyValue('--dur-fast')) || 180,
        easing: style.getPropertyValue('--ease-out').trim() || 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    )
    return () => animation.cancel()
  }, [summaryId, live])
  const visibleActivity = disclosure.contentMounted
    ? activityItemsForRender(activity.group, activity.items, activity.liveItems).filter(
        isWorkDisclosureItem,
      )
    : undefined

  if (!summaryItem) return null

  return (
    <div
      className={`activity${live ? ' activity--live' : ''}${settling ? ' is-settling' : ''}`}
      data-expanded={disclosure.expanded}
    >
      <button
        type="button"
        className="activity__summary"
        ref={summaryRef}
        aria-expanded={disclosure.expanded}
        title={label}
        onClick={disclosure.toggle}
      >
        {live || !hasCommentary ? (
          <span className="activity__glyph" aria-hidden>
            {glyph(summaryItem)}
          </span>
        ) : null}
        <span className="activity__label" aria-live="polite" aria-atomic="true">
          {label}
        </span>
        <ChevronRight className="activity__chevron" size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div
        className="activity__reveal"
        data-open={disclosure.dataOpen}
        aria-hidden={!disclosure.expanded}
        inert={!disclosure.expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'clip-path')
            disclosure.finishClosing()
        }}
      >
        {disclosure.contentMounted ? (
          <div className="activity__reveal-clip">
            <div className="activity__body">
              {(visibleActivity ? groupCommandRuns(visibleActivity) : []).map((item) => {
                if (Array.isArray(item)) {
                  return <CommandRun key={item[0]!.id} items={item} live={live} />
                }
                if (item.type === 'command' || item.type === 'file_change') {
                  return <AuxDisclosure key={item.id} item={item} live={false} />
                }
                if (item.type === 'message') {
                  return (
                    <div className="activity__message" key={item.id}>
                      <Markdown text={item.text ?? ''} projectPath={projectPath} />
                    </div>
                  )
                }
                const detail = activityDetail(item)
                const itemLabel = activityItemLabel(item)
                return (
                  <div
                    className="activity__item"
                    data-failed={
                      item.status === 'failed' ||
                      (item.exitCode !== undefined && item.exitCode !== 0)
                    }
                    key={item.id}
                  >
                    <div className="activity__file-change">
                      {glyph(item)}
                      <span className="activity__item-label" title={itemLabel}>
                        {itemLabel}
                      </span>
                      {item.exitCode !== undefined && item.exitCode !== 0 ? (
                        <span className="aux__code">exit {item.exitCode}</span>
                      ) : null}
                      {item.durationMs !== undefined && item.durationMs >= 1000 ? (
                        <span className="aux__time">{duration(item.durationMs)}</span>
                      ) : null}
                    </div>
                    {detail ? (
                      isImageView(item) && item.status === 'completed' ? (
                        <ViewedImagePreview
                          reference={detail}
                          active={disclosure.expanded}
                          fallbackClassName="activity__detail"
                        />
                      ) : (
                        <pre className="activity__detail">{detail}</pre>
                      )
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function isWorkDisclosureItem(item: Item): boolean {
  return (
    isStackedActivity(item) ||
    (item.type === 'message' && item.role === 'assistant' && Boolean(item.text?.trim()))
  )
}

function activityDetail(item: Item): string | undefined {
  if (item.type === 'tool_call' && designPhaseLabel(toolText(item))) return undefined
  if (isContextCompaction(item)) return undefined
  const image = imageViewDetail(item)
  if (image !== undefined) return image
  if (item.type === 'tool_call') return toolCallDetail(item)
  if (item.type === 'command' && item.command) {
    const detail = toolCallDetail(item)
    if (detail !== undefined) return detail
    if (/\s[[{]/.test(item.text ?? '')) return undefined
  }
  const details =
    item.type === 'command' ? [item.text] : item.type === 'file_change' ? [item.text] : [item.text]
  const unique = details.filter(
    (detail, index) =>
      detail &&
      detail !== activityItemLabel(item) &&
      detail !== item.command &&
      detail !== item.path &&
      details.indexOf(detail) === index,
  )
  return unique.length > 0 ? unique.join('\n') : undefined
}

function toolCallHeadline(item: Item): string {
  const firstLine = (item.text ?? '').split('\n', 1)[0]?.trim() ?? ''
  const withoutPayload = firstLine.replace(/\s*[[{].*$/, '').trim()
  const raw = withoutPayload || firstLine
  return raw ? humanToolHeadline(raw) : 'Tool call'
}

function humanToolHeadline(raw: string): string {
  const space = raw.indexOf(' ')
  const token = (space === -1 ? raw : raw.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : raw.slice(space + 1)
  if (token === 'read_file') return rest ? `Read ${rest}` : 'Read file'
  if (token === 'grep' || token === 'codebase_search') {
    return rest ? `Searched ${rest}` : 'Searched'
  }
  if (token === 'list_dir' || token === 'list_files') {
    return rest ? `Listed ${rest}` : 'Listed files'
  }
  if (/[_-]/.test(token)) {
    const named = token.replaceAll(/[_-]+/g, ' ')
    const titled = `${named.charAt(0).toUpperCase()}${named.slice(1)}`
    return rest ? `${titled} ${rest}` : titled
  }
  return raw
}

function toolCallDetail(item: Item): string | undefined {
  const text = item.text?.trim()
  if (!text) return undefined
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  const rest = text.includes('\n') ? text.slice(firstLine.length + 1).trim() : ''
  const payloadIndex = firstLine.search(/\s[[{]/)
  const firstLinePayload = payloadIndex > 0 ? firstLine.slice(payloadIndex).trim() : ''
  const payload = [firstLinePayload, rest].filter(Boolean).join('\n') || undefined
  return payload ? unwrapToolPayload(payload) : undefined
}

function unwrapToolPayload(text: string): string | undefined {
  const trimmed = text.trim()
  const values = parseJsonSequence(trimmed)
  if (!values) return trimmed
  const parts = values
    .map((value) => readableToolJson(value))
    .filter((value): value is string => value !== undefined)
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join('\n') : undefined
}

function parseJsonSequence(text: string): unknown[] | undefined {
  const values: unknown[] = []
  let index = 0
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1
    if (index >= text.length) break
    if (text[index] !== '{' && text[index] !== '[') return undefined

    const start = index
    let depth = 0
    let inString = false
    let escaped = false
    let closed = false
    for (; index < text.length; index += 1) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{' || character === '[') depth += 1
      else if (character === '}' || character === ']') {
        depth -= 1
        if (depth === 0) {
          index += 1
          closed = true
          break
        }
      }
    }
    if (!closed) return undefined
    try {
      values.push(JSON.parse(text.slice(start, index)) as unknown)
    } catch {
      return undefined
    }
  }
  return values.length > 0 ? values : undefined
}

function readableToolJson(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined || value === '') return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return readableToolJson(JSON.parse(trimmed) as unknown, depth + 1) ?? value
      } catch {
        return value
      }
    }
    return value
  }
  if (typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === 'number')) return undefined
    const parts = value
      .map((entry) => readableToolJson(entry, depth + 1))
      .filter((entry): entry is string => entry !== undefined)
    const unique = [...new Set(parts)]
    return unique.length ? unique.join('\n') : undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ['text', 'stdout', 'output', 'result', 'message', 'content']) {
    if (key in record) {
      const extracted = readableToolJson(record[key], depth + 1)
      if (extracted) return extracted
    }
  }
  return undefined
}

function isSearchTool(text: string): boolean {
  return text.includes('search') || /\bgrep\b/.test(text)
}

function ViewedImagePreview({
  reference,
  active,
  fallbackClassName,
  variant = 'detail',
}: {
  reference: string
  active: boolean
  fallbackClassName?: string
  variant?: 'detail' | 'message'
}) {
  const [preview, setPreview] = useState<PickedAttachment>()
  const [previewSettled, setPreviewSettled] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setPreview(undefined)
    setPreviewSettled(false)
    setThumbnailFailed(false)
    setImageFailed(false)
    void previewViewedImage(reference)
      .then((result) => {
        if (!cancelled) {
          setPreview(result)
          setPreviewSettled(true)
        }
      })
      .catch(() => {
        if (!cancelled) setPreviewSettled(true)
      })
    return () => {
      cancelled = true
    }
  }, [active, reference])

  const inlineSource =
    preview?.thumbnailUrl && !thumbnailFailed ? preview.thumbnailUrl : preview?.previewUrl
  if (!preview || !inlineSource || !preview.previewUrl || imageFailed) {
    if (variant === 'detail' && fallbackClassName) {
      return <pre className={fallbackClassName}>{reference}</pre>
    }
    return (
      <span
        className={`viewed-image-preview viewed-image-preview--message ${previewSettled ? 'is-unavailable' : 'is-loading'}`}
        role="status"
        aria-label={
          previewSettled
            ? `Preview unavailable for ${attachmentName(reference)}`
            : `Loading preview of ${attachmentName(reference)}`
        }
      >
        <span className="viewed-image-preview__placeholder" aria-hidden>
          <Images />
          {previewSettled ? (
            <span className="viewed-image-preview__unavailable-copy">
              {attachmentName(reference)}
            </span>
          ) : null}
        </span>
      </span>
    )
  }

  return (
    <div
      className={`viewed-image-preview${variant === 'message' ? ' viewed-image-preview--message' : ''}`}
    >
      <button
        type="button"
        className="viewed-image-preview__open"
        aria-label={`Open preview of ${preview.name}`}
        onPointerEnter={preloadMediaViewer}
        onFocus={preloadMediaViewer}
        onClick={() => setViewerOpen(true)}
      >
        <img
          src={inlineSource}
          onLoad={preloadMediaViewer}
          alt={`Preview of ${preview.name}`}
          draggable={false}
          onError={() =>
            preview.thumbnailUrl && !thumbnailFailed
              ? setThumbnailFailed(true)
              : setImageFailed(true)
          }
        />
      </button>
      {variant === 'detail' ? (
        <span className="viewed-image-preview__name" title={reference}>
          {reference}
        </span>
      ) : null}
      {viewerOpen ? (
        <Suspense fallback={null}>
          <MediaViewer
            src={preview.previewUrl}
            thumbnailSrc={inlineSource}
            name={preview.name}
            mediaType="image"
            onReveal={variant === 'message' ? () => void revealPath(reference) : undefined}
            onClose={() => setViewerOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

const IMAGE_ATTACHMENT_RE = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|webp)$/i

function isImageAttachment(reference: string): boolean {
  return IMAGE_ATTACHMENT_RE.test(reference)
}

function attachmentName(reference: string): string {
  return reference.split(/[\\/]/).filter(Boolean).at(-1) ?? reference
}

function activityStackLabel(items: Item[]): string {
  const onlyItem = items.length === 1 ? items[0] : undefined
  if (
    onlyItem &&
    (onlyItem.status !== 'completed' ||
      (onlyItem.exitCode !== undefined && onlyItem.exitCode !== 0))
  ) {
    return activityItemLabel(onlyItem)
  }

  const categories = items.reduce<string[]>((labels, item) => {
    const label = activityCategoryLabel(item)
    if (!labels.includes(label)) labels.push(label)
    return labels
  }, [])

  return categories
    .map((label, index) => (index === 0 ? label : `${label[0]?.toLowerCase()}${label.slice(1)}`))
    .join(', ')
}

function activityCategoryLabel(item: Item): string {
  switch (item.type) {
    case 'command':
      return 'Ran commands'
    case 'file_change':
      return 'Edited files'
    case 'plan':
      return 'Updated plan'
    case 'tool_call': {
      const text = toolText(item)
      if (isContextCompaction(item)) return 'Compacted context window'
      if (isImageView(item) || text.includes('image')) return 'Viewed images'
      if (isSearchTool(text)) return 'Searched'
      if (text.match(/read|open|file|list/)) return 'Read files'
      return 'Used tools'
    }
    default:
      return 'Used tools'
  }
}

function liveActivityLabel(item: Item): string {
  const ongoing = item.status === 'started'

  switch (item.type) {
    case 'command': {
      const command = inlineActivityText(item.command)
      if (item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)) {
        return command ? `Command failed: ${command}` : 'Command failed'
      }
      if (!command) return ongoing ? 'Running a command' : 'Ran a command'
      return `${ongoing ? 'Running' : 'Ran'} ${command}`
    }
    case 'file_change': {
      const path = inlineActivityText(item.path)
      if (!path) return ongoing ? 'Editing files' : 'Edited files'
      return `${ongoing ? 'Editing' : 'Edited'} ${path}`
    }
    case 'tool_call': {
      const text = toolText(item)
      if (isImageView(item)) {
        if (item.status === 'failed') return 'Could not view image'
        return ongoing ? 'Viewing image' : 'Viewed image'
      }
      if (text.includes('image')) return ongoing ? 'Viewing images' : 'Viewed images'
      if (isSearchTool(text)) return ongoing ? 'Searching' : 'Searched'
      if (text.match(/read|open|file|list/)) return ongoing ? 'Reading files' : 'Read files'
      const tool = inlineActivityText(toolCallHeadline(item))
      if (!tool || tool === 'Tool call') return ongoing ? 'Using a tool' : 'Used a tool'
      return `${ongoing ? 'Using' : 'Used'} ${tool}`
    }
    case 'plan':
      return ongoing ? 'Updating the plan' : 'Updated the plan'
    default:
      return summariseLive(item)
  }
}

function activityItemLabel(item: Item): string {
  if (item.type === 'command') {
    const command = inlineActivityText(item.command)
    if (item.status === 'started')
      return command ? `Command interrupted: ${command}` : 'Command interrupted'
    if (item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return command ? `Command failed: ${command}` : 'Command failed'
    }
    return command ? `Ran ${command}` : 'Ran a command'
  }

  if (item.type === 'file_change') {
    const path = inlineActivityText(item.path)
    if (item.status === 'started') return path ? `Edit interrupted: ${path}` : 'Edit interrupted'
    if (item.status === 'failed') return path ? `Could not edit ${path}` : 'Could not edit files'
    return path ? `Edited ${path}` : 'Edited files'
  }

  if (item.type === 'plan') return 'Updated plan'

  return summarise(item)
}

function inlineActivityText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? ''
}

function ResponseActions({
  text,
  createdAt,
  checkpoint,
  onRevertCheckpoint,
}: {
  text: string
  createdAt: number
  checkpoint: Checkpoint | undefined
  onRevertCheckpoint: ((checkpoint: Checkpoint) => void) | undefined
}) {
  return (
    <div className="response-actions" aria-label="Response actions">
      <CopyAction text={text} label="Copy response" />
      {checkpoint && onRevertCheckpoint ? (
        <button
          type="button"
          onClick={() => onRevertCheckpoint(checkpoint)}
          aria-label="Revert to before response"
          title="Revert"
        >
          <RotateCcw aria-hidden />
        </button>
      ) : null}
      <time dateTime={new Date(createdAt).toISOString()}>
        {new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </time>
    </div>
  )
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  // Rows are virtualized, so this unmounts the moment it scrolls out of the
  // overscan window — the tick-reset timer must not outlive it.
  const resetTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const copy = async () => {
    try {
      await writeClipboardText(text)
      setFailed(false)
      setCopied(true)
      window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      window.clearTimeout(resetTimer.current)
      setCopied(false)
      setFailed(true)
    }
  }

  return (
    <span className={`copy-action${failed ? ' is-failed' : ''}`}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        title={failed ? 'Copy failed — click to retry' : 'Copy'}
      >
        <IconMorph active={failed ? 2 : copied ? 1 : 0}>
          <Copy aria-hidden />
          <Check aria-hidden />
          <CircleAlert aria-hidden />
        </IconMorph>
      </button>
      {failed ? (
        <span className="copy-action__error" role="alert">
          Copy failed
        </span>
      ) : null}
    </span>
  )
}

const FrameWorkingRail = memo(function FrameWorkingRail({
  frameStore,
  items,
  turnId,
  liveStart,
  activityIndices,
  startedAt,
}: {
  frameStore: ThreadFrameStore
  items: Item[]
  turnId: string
  liveStart: number
  activityIndices: readonly number[]
  startedAt: number
}) {
  const liveItems = useFrameLiveItems(frameStore, activityIndices)
  const searching = activeTurnIsSearching(items, turnId, liveItems, liveStart, activityIndices)
  const label = workLabel(items, turnId, searching, liveItems, liveStart, activityIndices)
  return <WorkingRail startedAt={startedAt} label={label} />
})

const WorkingRail = memo(function WorkingRail({
  startedAt,
  label,
}: {
  startedAt: number
  label: string
}) {
  return (
    <div className="activity activity--working">
      <div className="activity__summary">
        <span className="activity__working-orb">
          <ThinkingOrb
            state={label === 'Searching' ? 'searching' : 'working'}
            size={20}
            aria-hidden
          />
        </span>
        <WorkingLabel label={label} startedAt={startedAt} />
      </div>
    </div>
  )
})

const WORKING_LABEL_MOTION_MS = 480

function WorkingLabel({ label, startedAt }: { label: string; startedAt: number }) {
  const lastLabel = useRef(label)
  const timer = useRef<number | undefined>(undefined)
  const [previousLabel, setPreviousLabel] = useState<string>()

  useLayoutEffect(() => {
    if (lastLabel.current === label) return

    setPreviousLabel(lastLabel.current)
    lastLabel.current = label
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setPreviousLabel(undefined)
    }, WORKING_LABEL_MOTION_MS)
  }, [label])

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )

  return (
    <span className="activity__working-label-swap" aria-live="polite" aria-atomic="true">
      {previousLabel ? (
        <span className="activity__working-status-previous" aria-hidden>
          <span className="activity__working-label-previous">{previousLabel}</span>
          <span className="activity__working-time">
            <WorkingTimer startedAt={startedAt} />
          </span>
        </span>
      ) : null}
      <span
        className={`activity__working-status${previousLabel ? ' is-entering' : ''}`}
        key={label}
      >
        <span className="activity__working-label">{label}</span>
        <span className="activity__working-time">
          <WorkingTimer startedAt={startedAt} />
        </span>
      </span>
    </span>
  )
}

export function workLabel(
  items: Item[],
  turnId: string | undefined,
  searching: boolean | undefined,
  liveItems: ReadonlyMap<number, LiveItemUpdate> = EMPTY_LIVE_ITEMS,
  liveStart = 0,
  activityIndices?: readonly number[],
) {
  if (searching) return 'Searching'
  if (!turnId) return 'Working'

  // The active turn's items are the tail of the transcript; once the walk
  // leaves them there is nothing further back worth scanning — without the
  // break this was a full-transcript scan per streamed frame.
  let latest: string | undefined
  if (activityIndices) {
    for (const index of activityIndices) {
      const item = threadItemAt(items, liveItems, index)
      if (!item || item.status !== 'started' || !isActivity(item)) continue
      if (isBlankReasoning(item)) continue
      if (item.type === 'tool_call') {
        const phase = designPhaseLabel(toolText(item))
        if (phase) return phase
      }
      latest ??= summariseLive(item)
    }
    return latest ?? 'Working'
  }

  for (let index = items.length - 1; index >= liveStart; index--) {
    const item = threadItemAt(items, liveItems, index)
    if (!item) continue
    if (item.turnId !== turnId) break
    if (item.status !== 'started' || !isActivity(item)) continue
    if (isBlankReasoning(item)) continue
    // A design phase owns its whole turn: its label must not flicker to
    // "Running a command" for every tool the provider uses inside it.
    if (item.type === 'tool_call') {
      const phase = designPhaseLabel(toolText(item))
      if (phase) return phase
    }
    latest ??= summariseLive(item)
  }

  return latest ?? 'Working'
}

// Updating this text node directly avoids committing the virtualized thread
// every second while a response is streaming.
function WorkingTimer({ startedAt }: { startedAt: number }) {
  const text = useRef<HTMLSpanElement>(null)
  const initial = workedFor(Math.max(0, Date.now() - startedAt))

  useEffect(() => {
    let timer: number | undefined
    const update = () => {
      if (text.current) text.current.textContent = workedFor(Math.max(0, Date.now() - startedAt))
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = undefined
      if (document.visibilityState === 'hidden') return
      update()
      const elapsed = Math.max(0, Date.now() - startedAt)
      timer = window.setTimeout(schedule, Math.max(50, 1_000 - (elapsed % 1_000)))
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [startedAt])

  return <span ref={text}>{initial}</span>
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export function workedFor(ms: number): string {
  let remaining = Math.max(1, Math.round(ms / 1000))
  const parts: string[] = []

  for (const [unit, seconds] of [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const value = Math.floor(remaining / seconds)
    remaining %= seconds
    if (value > 0) parts.push(`${value}${unit}`)
  }

  return parts.join(' ')
}

function glyph(item: Item) {
  if (isContextCompaction(item)) return <ArrowDownToLine size={13} />

  switch (item.type) {
    case 'message':
      return <Brain size={13} />
    case 'command':
      return <SquareTerminal size={13} />
    case 'reasoning':
      return <Brain size={13} />
    case 'file_change':
      return <FilePenLine size={13} />
    case 'tool_call':
      if (toolText(item).includes('image')) return <Images size={14} />
      if (designPhaseLabel(toolText(item))) return <Palette size={13} />
      if (isSearchTool(toolText(item))) return <Search size={14} />
      if (toolText(item).match(/read|open|file|list/)) return <BookOpen size={14} />
      return <Wrench size={13} />
    case 'plan':
      return <ListChecks size={13} />
    default:
      return <CircleQuestionMark size={13} />
  }
}

function summariseLive(item: Item): string {
  const ongoing = item.status === 'started'
  const supportedActivity = supportedActivitySummary(item, ongoing)
  if (supportedActivity) return supportedActivity

  switch (item.type) {
    case 'command':
      return liveActivityLabel(item)
    case 'reasoning':
      return ongoing ? 'Thinking' : thoughtLabel(item, false)
    case 'file_change':
      return ongoing ? 'Editing files' : 'Edited files'
    case 'tool_call': {
      const text = toolText(item)
      const designPhase = designPhaseLabel(text)
      if (designPhase) return designPhase
      if (isContextCompaction(item)) {
        if (item.status === 'failed') return 'Could not compact context window'
        return ongoing ? 'Compacting context window…' : 'Compacted context window'
      }
      if (isImageView(item)) {
        if (item.status === 'failed') return 'Could not view image'
        return ongoing ? 'Viewing image' : 'Viewed image'
      }
      if (text.includes('image')) return ongoing ? 'Viewing an image' : 'Viewed an image'
      if (isSearchTool(text)) return ongoing ? 'Searching' : 'Searched'
      if (text.match(/read|open|file|list/)) return ongoing ? 'Reading files' : 'Read files'
      return ongoing ? 'Using a tool' : 'Used a tool'
    }
    case 'plan':
      return ongoing ? 'Updating the plan' : 'Updated the plan'
    case 'unknown':
      return unknownActivityLabel(item)
    default:
      return summarise(item)
  }
}

function designPhaseLabel(text: string): string | undefined {
  if (text.includes('design:brief')) return 'Understanding the request'
  if (text.includes('design:brand')) return 'Creating brand direction'
  if (text.includes('design:page')) return 'Planning the page'
  if (text.includes('design:assets')) return 'Gathering assets'
  if (text.includes('design:build')) return 'Building the website'
  if (text.includes('design:preview')) return 'Starting the preview'
  if (text.includes('design:review')) return 'Reviewing the design'
  if (text.includes('design:repair')) return 'Refining the website'
  return undefined
}

function toolText(item: Item): string {
  return `${item.text ?? ''} ${item.command ?? ''}`.toLowerCase()
}

function summarise(item: Item): string {
  const supportedActivity = supportedActivitySummary(item, false)
  if (supportedActivity) return supportedActivity

  switch (item.type) {
    case 'command':
      if (item.status === 'started') return 'Command interrupted'
      if (item.exitCode !== undefined && item.exitCode !== 0) return 'Command failed'
      return 'Ran a command'
    case 'reasoning':
      return thoughtLabel(item, false)
    case 'file_change':
      return 'Edited files'
    case 'tool_call':
      // Design phase markers carry an internal slug; the reader gets the
      // same human label the working rail used while the phase ran.
      return (
        designPhaseLabel(toolText(item)) ??
        (isContextCompaction(item)
          ? item.status === 'failed'
            ? 'Could not compact context window'
            : item.status === 'started'
              ? 'Context compaction interrupted'
              : 'Compacted context window'
          : isImageView(item)
            ? item.status === 'failed'
              ? 'Could not view image'
              : item.status === 'started'
                ? 'Image inspection interrupted'
                : 'Viewed image'
            : toolCallHeadline(item))
      )
    case 'plan':
      return 'Plan'
    case 'unknown':
      return unknownActivityLabel(item)
    default:
      return 'Activity'
  }
}

function supportedActivitySummary(item: Item, ongoing: boolean): string | undefined {
  if (item.type !== 'tool_call' && item.type !== 'unknown') return undefined
  const name = (item.text ?? '')
    .split('\n', 1)[0]
    ?.replaceAll(/[^a-z0-9]/gi, '')
    .toLowerCase()
  const failed = item.status === 'failed'
  const interrupted = item.status === 'started' && !ongoing

  switch (name) {
    case 'contextcompaction':
      return failed
        ? 'Could not compact context window'
        : interrupted
          ? 'Context compaction interrupted'
          : ongoing
            ? 'Compacting context window…'
            : 'Compacted context window'
    case 'imagegeneration':
      return failed
        ? 'Could not generate an image'
        : interrupted
          ? 'Image generation interrupted'
          : ongoing
            ? 'Generating an image'
            : 'Generated an image'
    case 'imageview':
      return failed
        ? 'Could not view image'
        : interrupted
          ? 'Image inspection interrupted'
          : ongoing
            ? 'Viewing image'
            : 'Viewed image'
    case 'hookprompt':
      return failed
        ? 'Hook failed'
        : interrupted
          ? 'Hook interrupted'
          : ongoing
            ? 'Running a hook'
            : 'Ran a hook'
    case 'sleep':
      return failed || interrupted ? 'Wait interrupted' : ongoing ? 'Waiting' : 'Waited'
    case 'enterreviewmode':
    case 'enteredreviewmode':
      return failed
        ? 'Could not enter review mode'
        : interrupted
          ? 'Review mode entry interrupted'
          : ongoing
            ? 'Entering review mode'
            : 'Entered review mode'
    case 'exitreviewmode':
    case 'exitedreviewmode':
      return failed
        ? 'Could not exit review mode'
        : interrupted
          ? 'Review mode exit interrupted'
          : ongoing
            ? 'Exiting review mode'
            : 'Exited review mode'
    default:
      return undefined
  }
}

function unknownActivityLabel(item: Item): string {
  const raw = item.text?.match(/^\[([^\]]+)]$/)?.[1]
  if (!raw || raw.toLowerCase() === 'unknown') return 'Agent activity'
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : 'Agent activity'
}

function isImageView(item: Item): boolean {
  return item.type === 'tool_call' && item.text?.split('\n', 1)[0]?.trim() === 'image view'
}

function isContextCompaction(item: Item): boolean {
  const text = item.text?.trim()
  return (
    (item.type === 'tool_call' && text === 'context compaction') ||
    (item.type === 'unknown' && text === '[contextCompaction]')
  )
}

function imageViewDetail(item: Item): string | undefined {
  if (!isImageView(item)) return undefined
  const detail = item.text?.split('\n').slice(1).join('\n').trim()
  return detail || undefined
}

/** A phase that retried produces one marker per adjacent provider turn; the
 *  reader cares that the phase happened, not about suppressed work between retries. */
export function isRepeatedDesignRow(item: Item, items: readonly Item[], index: number): boolean {
  if (item.type !== 'tool_call') return false
  const phase = designPhaseLabel(toolText(item))
  if (!phase) return false

  let adjacentTurn: string | undefined
  for (let priorIndex = index - 1; priorIndex >= 0; priorIndex--) {
    const prior = items[priorIndex]
    if (!prior) continue
    const priorPhase = prior.type === 'tool_call' ? designPhaseLabel(toolText(prior)) : undefined
    if (priorPhase) {
      return priorPhase === phase && (adjacentTurn === undefined || adjacentTurn === prior.turnId)
    }
    if (!isActivity(prior)) return false
    if (prior.turnId === item.turnId) continue
    if (adjacentTurn !== undefined && adjacentTurn !== prior.turnId) return false
    adjacentTurn = prior.turnId
  }
  return false
}

/** Retain the few computed phase rows when only the transcript tail changes. */
export function createRepeatedDesignRowProjector(): (
  items: readonly Item[],
) => (item: Item, index: number) => boolean {
  let previousItems: readonly Item[] | undefined
  let results = new Map<number, boolean>()
  let lookup = repeatedDesignRowLookup([], results)

  return (items) => {
    if (items === previousItems) return lookup
    const retained = previousItems ? retainedItemPrefix(previousItems, items) : 0
    if (retained === 0) results = new Map()
    else for (const index of results.keys()) if (index >= retained) results.delete(index)
    previousItems = items
    lookup = repeatedDesignRowLookup(items, results)
    return lookup
  }
}

function repeatedDesignRowLookup(
  items: readonly Item[],
  results: Map<number, boolean>,
): (item: Item, index: number) => boolean {
  return (item, index) => {
    if (item.type !== 'tool_call' || !designPhaseLabel(toolText(item))) return false
    if (results.has(index)) return results.get(index)!
    const repeated = isRepeatedDesignRow(item, items, index)
    results.set(index, repeated)
    return repeated
  }
}

function retainedItemPrefix(previous: readonly Item[], next: readonly Item[]): number {
  if (
    next.length === previous.length + 1 &&
    (previous.length === 0 || previous.at(-1) === next[previous.length - 1])
  ) {
    return previous.length
  }
  if (
    previous.length === next.length + 1 &&
    (next.length === 0 || next.at(-1) === previous[next.length - 1])
  ) {
    return next.length
  }
  if (
    next.length === previous.length &&
    next.length > 0 &&
    (next.length === 1 || previous[next.length - 2] === next[next.length - 2])
  ) {
    return next.length - 1
  }
  return 0
}
