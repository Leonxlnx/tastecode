import {
  useContext,
  Fragment,
  lazy,
  memo,
  Suspense,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  elementScroll,
  measureElement as measureVirtualElement,
  useVirtualizer,
  type Range,
  type VirtualizerOptions,
  type Virtualizer,
} from '@tanstack/react-virtual'
import type { ApprovalDecision, Item, ProviderNotice } from '@harness/contracts'
import { agentMark, providerDisplayName, providerMark } from '../provider-presentation.js'
import { AccountLabelContext, type AccountLabel } from '../provider-accounts-state.js'
import { ProviderIcon } from './ProviderIcon.js'
import {
  IconArrowBarToDown as ArrowDownToLine,
  IconBook2 as BookOpen,
  IconBrain as Brain,
  IconChevronRight as ChevronRight,
  IconAlertCircle as CircleAlert,
  IconHelpCircle as CircleQuestionMark,
  IconFilePencil as FilePenLine,
  IconHistory as History,
  IconLibraryPhoto as Images,
  IconListCheck as ListChecks,
  IconLoader2 as LoaderCircle,
  IconPalette as Palette,
  IconPencil as Pencil,
  IconPlayerStop as Stop,
  IconRotate as RotateCcw,
  IconSearch as Search,
  IconStack2 as Layers,
  IconTerminal2 as SquareTerminal,
  IconTool as Wrench,
  IconWorldSearch as WorldSearch,
} from '@tabler/icons-react'
import {
  canPreviewViewedImages,
  knownViewedImagePreview,
  previewViewedImage,
  revealPath,
} from '../bridge.js'
import {
  FIND_IN_CHAT_SHORTCUT,
  isEditableTarget,
  matchesShortcut,
  NEXT_TURN_SHORTCUT,
  PREVIOUS_TURN_SHORTCUT,
} from '../shortcuts.js'
import type { Transport } from '../transport.js'
import { Approval } from './Approval.js'
import { ChangeStats, Diff, parseDiff } from './Diff.js'
import { parseToolCall, toolArgumentEntries, toolArgumentSnippet } from './tool-call-text.js'
import { CopyButton } from './CopyButton.js'
import { LazyMediaViewer as MediaViewer, preloadMediaViewer } from './LazyMediaViewer.js'
import { Markdown } from './Markdown.js'
import { Plan } from './Plan.js'
import { ThreadSkeleton } from './Skeleton.js'
import {
  REVEAL_CLOSE_MS,
  REVEAL_EASING,
  REVEAL_OPEN_MS,
  RowMeasureContext,
  useDisclosure,
} from './disclosure.js'
import {
  runningSubagentCount,
  runningSubagentsText,
  subagentActivityLabel,
  SubagentGlyph,
  SubagentGroup,
  SubagentRow,
  waitingSubagentsLabel,
} from './SubagentRow.js'
import { FindBarSkeleton } from './SurfaceSkeletons.js'
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
  TURN_TOP_GAP,
  turnRoom,
  type ScrollMode,
} from './scroll-mode.js'
import { createFollowGlide, type FollowGlide } from './scroll-follow.js'
import { useVirtualItemKey } from './use-virtual-item-key.js'
import { nearOlderHistoryEdge, prependedRowCount } from './older-history.js'
import { shiftPendingScrollIndex } from './pending-scroll.js'
import { useOlderHistory } from './use-older-history.js'
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

/** Space kept between a disclosure's summary and the viewport edge it moves toward. */
const HEADER_MARGIN = 12

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
  /** Why the transcript could not be read; an empty thread is then not a new chat. */
  loadFailure?: string | undefined
  /** Read the transcript again after `loadFailure`; needs a stable identity. */
  onRetryLoad?: (() => void) | undefined
  projectPath?: string | undefined
  stopping?: boolean | undefined
  threadId?: string | undefined
  transport?: Transport | undefined
  searchJump?: { turnId: string; request: number } | undefined
  /** A search jump has landed on its turn; the owner drops it so the next entry opens at the end. */
  onSearchJumpDone?: ((request: number) => void) | undefined
  revealRequest?: number | undefined
  checkpoints?: Checkpoint[] | undefined
  keyboardActive?: boolean | undefined
  onEditMessage?: ((text: string) => void) | undefined
  onRevertCheckpoint?: ((checkpoint: Checkpoint) => void) | undefined
  onUndoChanges?:
    ((threadId: string, turnId: string, expectedDiff: string) => Promise<void>) | undefined
  /** Load turns above the transcript; needs a stable identity. */
  onLoadOlderHistory?: ((threadId: string, turnLimit?: number) => Promise<void>) | undefined
  /** Load every turn above the transcript in one read; an aborted read is dropped. */
  onLoadCompleteHistory?: ((threadId: string, signal: AbortSignal) => Promise<void>) | undefined
  onDecide: (id: string, decision: ApprovalDecision) => void
  onAnswerUserInput: (id: string, answers: Record<string, string[]>) => void | Promise<void>
  /** Keep agent questions inside this thread instead of the main composer. */
  inlineUserInput?: boolean | undefined
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
  const runwayRef = useRef<HTMLDivElement | null>(null)
  const threadIdRef = useRef(props.threadId)
  threadIdRef.current = props.threadId
  /** The chat the follow last opened at its end; nothing follows a chat before that. */
  const openedThread = useRef<{ threadId: string | undefined } | undefined>(undefined)
  /** What runs once the virtual list has measured a row; set once its parts exist below. */
  const virtualChanged = useRef<() => void>(() => undefined)
  const onVirtualChange = useCallback(() => virtualChanged.current(), [])
  /** Scroll to apply once the runway has committed a disclosure's new height. */
  const pendingEndAnchor = useRef<EndAnchor | undefined>(undefined)
  /** Settled scroll height in reveal-hold; growth past it is new content. */
  const heldHeight = useRef(0)
  const [mode, setMode] = useState<ScrollMode>('follow-end')
  const [finding, setFinding] = useState(false)
  const completedSearchJump = useRef(0)
  const completedRevealRequest = useRef(props.revealRequest ?? 0)
  const modeRef = useRef(mode)
  modeRef.current = mode
  /**
   * Jump to latest is offered only once the end is a real distance away, and
   * withdrawn only once it is close again. Without the gap between the two a
   * scroll that hovers around one threshold made the pill flicker, and a
   * small move up during a stream put it over the very text being read.
   */
  const [jumpShown, setJumpShown] = useState(false)
  const jumpShownRef = useRef(false)
  const updateJump = useCallback((distance: number) => {
    const shown = jumpShownRef.current
    const next =
      modeRef.current === 'free' && (shown ? distance >= JUMP_HIDE_PX : distance > JUMP_SHOW_PX)
    if (next === shown) return
    jumpShownRef.current = next
    setJumpShown(next)
  }, [])

  /** Index the latest turn starts at: the row a pinned prompt holds near the top. */
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
  const follow = useRef<FollowState>({
    knownTop: 0,
    measured: false,
    extra: 0,
    clientHeight: 0,
    total: 0,
    contentTop: 0,
    pinned: false,
    room: 0,
    liveUntil: 0,
    instantUntil: 0,
    holding: false,
    intent: undefined,
  })
  /** The virtual list's scroll correction still to be written; see scrollToFn. */
  const listScroll = useRef<ListScroll | undefined>(undefined)
  // While a turn streams, the end glides into view instead of jumping a line
  // at a time. Its writes are ours like any other, so they are recorded the
  // same way; sub-pixel steps are exact, hence no 1px early return here.
  const [glide] = useState<FollowGlide>(() =>
    createFollowGlide({
      write: (top) => {
        const el = scroller.current
        if (!el) return
        writtenScrollTop.current = top
        follow.current.knownTop = top
        el.scrollTop = top
      },
    }),
  )
  useEffect(() => () => glide.stop(), [glide])
  const writeScrollTop = useCallback(
    (el: HTMLElement, top: number) => {
      // A write puts the scroll somewhere on purpose; a glide continuing from
      // its own idea of the position would undo it on the next frame.
      glide.stop()
      // So does a correction the virtual list has not written yet: this one is newer.
      listScroll.current = undefined
      // Clamp before comparing: an out-of-range target gets clamped by the
      // browser, so the write would land somewhere we did not record.
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      const target = Math.min(Math.max(top, 0), max)
      if (Math.abs(el.scrollTop - target) < 1) {
        follow.current.knownTop = el.scrollTop
        return
      }
      writtenScrollTop.current = target
      follow.current.knownTop = target
      el.scrollTop = target
    },
    [glide],
  )
  /**
   * The frame request of a running "Jump to latest" glide. A native smooth
   * scroll fixes its target when it starts, so it lands short of a reply that
   * keeps growing and never reaches the end it was sent to. The glide chases
   * the settled end on every frame instead and hands over to follow-end once
   * it is there.
   */
  const jumpFrame = useRef<number | undefined>(undefined)
  const stopJump = useCallback(() => {
    if (jumpFrame.current !== undefined) window.cancelAnimationFrame(jumpFrame.current)
    jumpFrame.current = undefined
  }, [])
  const jumpToLatest = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stopJump()
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let last: number | undefined
    let velocity = 0
    const step = (now: number) => {
      jumpFrame.current = undefined
      const elapsed = last === undefined ? 16 : Math.min(64, Math.max(0, now - last))
      last = now
      // The room below a pinned prompt counts: that end is the latest.
      const end = Math.max(0, settledScrollHeight(el) + follow.current.room - el.clientHeight)
      const from = el.scrollTop
      const gap = end - from
      // Within reach of the follow glide, hand over at the chase's own speed:
      // the last stretch then slows into the end and keeps following it,
      // instead of arriving at full speed and stopping dead.
      if (!instant && Math.abs(gap) <= JUMP_HANDOVER_PX) {
        modeRef.current = 'follow-end'
        setMode('follow-end')
        glide.setTarget(end, from, velocity)
        return
      }
      // Ease out towards wherever the end is now, at the same pace whatever
      // the frame rate. An ease alone trails an end that keeps moving by a
      // constant distance and never arrives; the minimum speed is faster
      // than any reply can be read, so the glide always catches up.
      const minimum = JUMP_MIN_PX_PER_MS * elapsed
      if (instant || Math.abs(gap) <= minimum) {
        modeRef.current = 'follow-end'
        setMode('follow-end')
        writeScrollTop(el, end)
        return
      }
      const travel = Math.max(Math.abs(gap) * (1 - Math.exp(-elapsed / JUMP_EASE_MS)), minimum)
      velocity = (Math.sign(gap) * travel) / Math.max(1, elapsed)
      writeScrollTop(el, from + Math.sign(gap) * travel)
      jumpFrame.current = window.requestAnimationFrame(step)
    }
    // Stay in free mode for the whole glide. Flipping to follow-end first
    // would unmount the button mid-flight; the glide hands over itself.
    jumpFrame.current = window.requestAnimationFrame(step)
  }, [glide, stopJump, writeScrollTop])
  // Any other mode means something else owns the scroll position now.
  useLayoutEffect(() => {
    if (mode !== 'free') stopJump()
    if (mode === 'free' || mode === 'reveal-hold') glide.stop()
    // The next time the user takes over, the pill waits for the full distance again.
    if (mode !== 'free' && jumpShownRef.current) {
      jumpShownRef.current = false
      setJumpShown(false)
    }
  }, [mode, stopJump, glide])
  useEffect(() => stopJump, [props.threadId, stopJump])
  const {
    status: olderHistory,
    loadOlder,
    canLoadOnScroll,
    completeStatus,
    loadComplete,
    cancelComplete,
  } = useOlderHistory(
    props.threadId,
    props.frameStore,
    props.onLoadOlderHistory,
    props.onLoadCompleteHistory,
  )
  const searchJumpRef = useRef(props.searchJump)
  searchJumpRef.current = props.searchJump
  const searchJumpDone = useRef(props.onSearchJumpDone)
  searchJumpDone.current = props.onSearchJumpDone
  const closeFind = useCallback(() => {
    setFinding(false)
    const jump = searchJumpRef.current
    // A search jump still waiting for its turn keeps the read it shares with find.
    if (!jump || completedSearchJump.current === jump.request) cancelComplete()
  }, [cancelComplete])
  const liveItems = thread.liveItems
  const enteringItemIds = useEnteringItemIds(thread.items, props.threadId)
  const settledTurnId = useSettledTurnId(running, thread.activeTurn?.id)
  const getItemKey = useVirtualItemKey(thread.items, props.threadId)
  /** Filled in once this render has projected the thread; read lazily by the virtualizer. */
  const estimateRow = useRef<(index: number) => number>(() => DEFAULT_ROW_ESTIMATE)
  const estimateSize = useCallback((index: number) => estimateRow.current(index), [])
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | undefined>(undefined)
  const rangeExtractor = useCallback(
    (range: Range) =>
      overscanVisibleRows(range, (index) => virtualizerRef.current?.measurementsCache[index]?.size),
    [],
  )

  // Older rows arrived above: remember which row sits at the top of the
  // viewport and how far into it, so the same pixels stay there after the
  // virtualizer lays the new rows out. Computed once per items array, so a
  // repeated render never re-reads measurements that already include them.
  // The baseline moves in render, together with the shifts below: a render
  // React throws away has still moved those refs, and the next render must not
  // shift them by the same rows again.
  const shiftedItems = useRef({ threadId: props.threadId, items: thread.items })
  const prepend = useRef<PrependAnchor | undefined>(undefined)
  if (prepend.current?.items !== thread.items) {
    const shifted = shiftedItems.current
    const shift =
      shifted.threadId === props.threadId ? prependedRowCount(shifted.items, thread.items) : 0
    const previous = virtualizerRef.current
    const offset = previous?.scrollOffset ?? null
    const row =
      shift > 0 && offset !== null && modeRef.current !== 'follow-end'
        ? previous?.getVirtualItemForOffset(offset)
        : undefined
    if (shift > 0) {
      // Row indexes recorded against the old rows now name rows `shift`
      // further down. Move them here, in render: FrameScrollFollower is a
      // child, so its layout effect runs before this component's and would
      // otherwise pin, measure or release the anchored turn by a stale index.
      anchorIndex.current += shift
      if (previous) shiftPendingScrollIndex(previous, shift)
    }
    prepend.current =
      shift > 0
        ? {
            items: thread.items,
            applied: false,
            previousSize: previous?.getTotalSize() ?? 0,
            ...(row && offset !== null
              ? { index: row.index + shift, offset: offset - row.start }
              : {}),
          }
        : undefined
  }
  shiftedItems.current = { threadId: props.threadId, items: thread.items }

  const projectThread = useMemo(createThreadProjector, [props.threadId])
  const { turns, presentations } = projectThread(
    thread.items,
    thread.turnTiming,
    thread.activeTurn?.id,
  )
  const activePresentation = thread.activeTurn ? presentations.get(thread.activeTurn.id) : undefined
  const showWorkingRail = running && thread.activeTurn !== undefined
  const railIndex = showWorkingRail ? activePresentation?.firstResponseIndex : undefined
  // Until the turn's first response row exists, the working rail sits at the
  // end of the runway, in space the runway itself keeps for it. A spacer
  // outside the runway left in the commit that added the row, a layout before
  // the row was measured with the rail's room: the transcript was briefly
  // shorter and the scroll was clamped.
  const railReserve = showWorkingRail && railIndex === undefined ? WORKING_RAIL_PX : 0

  /**
   * The virtual list moves the scroll itself: when a row above the viewport
   * changes size, and to reach a row. Those moves are ours too. The follow
   * glide carries on from where they put the scroll; comparing the end with
   * its own older position instead snapped the view onto the end. At a turn
   * end that turned the glide's lag into a jump: the finished work above the
   * reply collapsed, the list compensated, and the reply then moved up by
   * the lag in one frame (8-10 px measured at an 800 px window).
   */
  const scrollList = useCallback<VirtualizerOptions<HTMLDivElement, Element>['scrollToFn']>(
    (offset, options, instance) => {
      elementScroll(offset, options, instance)
      const el = scroller.current
      if (!el) return
      const top = el.scrollTop
      writtenScrollTop.current = top
      follow.current.knownTop = top
      if (glide.running) glide.sync(top)
    },
    [glide],
  )
  const flushListScroll = useCallback(() => {
    const pending = listScroll.current
    if (!pending) return
    listScroll.current = undefined
    scrollList(pending.offset, { adjustments: pending.adjustments }, pending.instance)
  }, [scrollList])
  /**
   * What the virtual list's notifications leave for the end of the task: its
   * scroll correction and the follow. Still before paint.
   */
  const virtualFlush = useRef({ queued: false, follow: false })
  const runVirtualFlush = useRef<() => void>(() => undefined)
  const queueVirtualFlush = useCallback(() => {
    const flush = virtualFlush.current
    if (flush.queued) return
    flush.queued = true
    queueMicrotask(() => {
      flush.queued = false
      runVirtualFlush.current()
    })
  }, [])
  /**
   * A correction for rows measured above the viewport is written once, when
   * the task that measured them is done. Row by row, each write laid the
   * whole transcript out again, as the row before had just moved everything
   * below it. The list carries its own offset forward at once, so its last
   * target is the sum of them all. A smooth scroll and a scroll to a place
   * are written at once.
   */
  const scrollToFn = useCallback<VirtualizerOptions<HTMLDivElement, Element>['scrollToFn']>(
    (offset, options, instance) => {
      if (options.adjustments === undefined || options.behavior === 'smooth') {
        listScroll.current = undefined
        scrollList(offset, options, instance)
        return
      }
      listScroll.current = { offset, adjustments: options.adjustments, instance }
      queueVirtualFlush()
    },
    [queueVirtualFlush, scrollList],
  )
  /**
   * Rows this commit mounted that the list has no size for yet. The list read
   * each one's height as its ref attached, right after it had positioned the
   * row before, so every read laid the transcript out again. They are read
   * together once the commit has attached them all (see measureMountedRows).
   */
  const unmeasuredRows = useRef<Element[]>([])
  const measureElement = useCallback<
    NonNullable<VirtualizerOptions<HTMLDivElement, Element>['measureElement']>
  >(
    (element, entry, instance) => {
      if (entry) return measureVirtualElement(element, entry, instance)
      const index = instance.indexFromElement(element)
      const cached = instance.itemSizeCache.get(instance.options.getItemKey(index))
      const assumed = instance.measurementsCache[index]?.size
      if (cached !== undefined || assumed === undefined) {
        return measureVirtualElement(element, entry, instance)
      }
      unmeasuredRows.current.push(element)
      queueVirtualFlush()
      // The size the list already assumes, so taking it changes nothing yet.
      return assumed
    },
    [queueVirtualFlush],
  )
  const virtualizer = useVirtualizer({
    count: thread.items.length,
    scrollToFn,
    measureElement,
    getScrollElement: () => scroller.current,
    // A wrong estimate costs a scroll correction when the row is first
    // measured. Hidden tool rows are most rows in a working session, so they
    // must estimate as nothing rather than a paragraph each.
    estimateSize,
    // Stable identity per item, never the index — index keys make every
    // insertion look like a change to every row after it.
    getItemKey,
    overscan: 8,
    rangeExtractor,
    // Assume a viewport for the very first render, before measurement has run.
    // Without it the first frame contains no rows at all, which reads as a
    // blank thread for one frame when switching sessions.
    initialRect: { width: 720, height: 800 },
    // Row positions and the runway height go to the DOM in the same callback
    // that measured a row. Through React, every wrapped line of a streamed
    // reply rendered the whole transcript again, and the runway took its new
    // height a render after the row that grew. The transcript now renders when
    // the rows it shows change.
    directDomUpdates: true,
    onChange: onVirtualChange,
    paddingEnd: railReserve,
  })
  virtualizerRef.current = virtualizer
  /**
   * Measures the rows mounted since the last call: every height first, while
   * nothing has moved, then the sizes. Runs when the commit has attached them
   * all, before anything opens or follows (FrameScrollFollower), and at the
   * end of the task for rows a row mounted on its own.
   */
  const measureMountedRows = useCallback(() => {
    const rows = unmeasuredRows.current
    if (rows.length === 0) return
    unmeasuredRows.current = []
    const sizes = rows.map((row) => (row.isConnected ? (row as HTMLElement).offsetHeight : -1))
    rows.forEach((row, index) => {
      if (sizes[index]! >= 0)
        virtualizer.resizeItem(virtualizer.indexFromElement(row), sizes[index]!)
    })
  }, [virtualizer])
  // Mocked lists in tests have no container to size.
  const sizeRunway = (virtualizer as { containerRef?: (node: HTMLElement | null) => void })
    .containerRef
  const setRunway = useCallback(
    (node: HTMLDivElement | null) => {
      runwayRef.current = node
      sizeRunway?.(node)
    },
    [sizeRunway],
  )
  /**
   * Gives the runway the virtual total now. The virtual list sizes it when it
   * measures a row, but for rows added or removed only after the commit's
   * effects; a follow that reads layout or scrolls before that would meet
   * last commit's runway. Both write the same total, so they never disagree.
   */
  const sizeRunwayNow = useCallback(() => {
    const runway = runwayRef.current
    const height = `${virtualizer.getTotalSize()}px`
    if (runway && runway.style.height !== height) runway.style.height = height
  }, [virtualizer])
  /** The settled scroll height, with the runway at the virtual total. */
  const settledHeight = useCallback(
    (el: HTMLElement) => {
      sizeRunwayNow()
      return settledScrollHeight(el)
    },
    [sizeRunwayNow],
  )

  /**
   * Reads what the end is made of besides the virtual rows. Only called
   * where layout is clean or has been read anyway (a resize notification,
   * opening a chat, a disclosure), never once per streamed frame.
   */
  const measureFollow = useCallback(
    (el: HTMLElement, settled = settledHeight(el)) => {
      const state = follow.current
      state.measured = true
      state.clientHeight = el.clientHeight
      state.extra = settled - virtualizer.getTotalSize()
      state.contentTop = Number.parseFloat(getComputedStyle(el).paddingTop) || 0
    },
    [settledHeight, virtualizer],
  )
  /**
   * The settled end of the scroll, from the virtual total and what was last
   * measured, held at a pinned prompt while its answer is shorter than the
   * screen; and the room below the content that makes that end reachable.
   */
  const endAndRoom = useCallback(() => {
    const state = follow.current
    const natural = Math.round(virtualizer.getTotalSize() + state.extra) - state.clientHeight
    const start = state.pinned
      ? virtualizer.measurementsCache[anchorIndex.current]?.start
      : undefined
    const pinned =
      start === undefined ? undefined : Math.round(state.contentTop + start - TURN_TOP_GAP)
    return turnRoom(natural, pinned)
  }, [virtualizer])
  const endOf = useCallback(() => endAndRoom().end, [endAndRoom])
  const roomRef = useRef<HTMLDivElement>(null)
  /**
   * Gives the transcript the room below its content that the end needs.
   * Written in the same step as the change that needs it, so the scroll
   * height stays the same while an answer grows into the room, and a scroll
   * towards the end is never clamped short of it. Outside the column, so the
   * settled height the follow measures never includes it.
   */
  const applyRoom = useCallback(() => {
    const state = follow.current
    const room = state.pinned && state.measured ? endAndRoom().room : 0
    if (room === state.room) return
    state.room = room
    if (roomRef.current) roomRef.current.style.height = room > 0 ? `${room}px` : ''
  }, [endAndRoom])
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), [])
  /**
   * Moves the viewport to a new end. While a turn streams it glides there;
   * otherwise, and whenever motion is unwanted or nobody can see it, the end
   * is written at once. Content that shrank is followed in the same frame:
   * the browser clamps the scroll there anyway.
   */
  const followTo = useCallback(
    (el: HTMLElement, end: number) => {
      const state = follow.current
      const now = performance.now()
      // The user has hold of the transcript, or just turned the wheel up and
      // its scroll has not arrived yet: nothing moves on its own meanwhile.
      if (state.holding || (state.intent?.up && now - state.intent.at < INTENT_MS)) return
      const glides =
        (glide.running || now < state.liveUntil) &&
        now >= state.instantUntil &&
        document.visibilityState === 'visible' &&
        !reducedMotion.matches
      const from = glide.running ? glide.position : state.knownTop
      if (!glides || end < from - 0.5) {
        if (glide.running || Math.abs(end - state.knownTop) >= 0.5) writeScrollTop(el, end)
        return
      }
      if (!glide.running && Math.abs(end - from) < 0.5) return
      glide.setTarget(end, from)
    },
    [glide, reducedMotion, writeScrollTop],
  )
  /**
   * The user handed the scroll back short of the end (a scroll that landed
   * near it, a released scrollbar). They moved there themselves, so the rest
   * of the way glides even when nothing is streaming.
   */
  const catchUp = useCallback(
    (el: HTMLElement) => {
      const state = follow.current
      if (state.holding) return
      const end = endOf()
      if (glide.running || reducedMotion.matches || document.visibilityState !== 'visible') {
        followTo(el, end)
      } else if (Math.abs(end - state.knownTop) >= 0.5) {
        glide.setTarget(end, state.knownTop)
      }
    },
    [endOf, followTo, glide, reducedMotion],
  )
  /**
   * A pointer or finger on the transcript means the user is selecting,
   * clicking or dragging the scrollbar; a glide would pull the content from
   * under them. Following resumes when they let go.
   */
  const hold = useCallback(
    (releaseOn: readonly string[]) => {
      stopJump()
      glide.stop()
      const state = follow.current
      if (state.holding) return
      state.holding = true
      const release = () => {
        for (const type of releaseOn) window.removeEventListener(type, release, true)
        state.holding = false
        const el = scroller.current
        if (el && modeRef.current === 'follow-end') catchUp(el)
      }
      for (const type of releaseOn) window.addEventListener(type, release, true)
    },
    [catchUp, glide, stopJump],
  )
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // Touch has its own events below: a touch scroll cancels the pointer
      // while the finger is still down.
      if (event.pointerType !== 'touch') hold(POINTER_RELEASE)
    },
    [hold],
  )
  const onTouchStart = useCallback(() => hold(TOUCH_RELEASE), [hold])
  /**
   * The user asked the transcript to move by `delta` px; the scroll arrives
   * after this. Successive steps of one gesture add up, as the browser's own
   * target does, so a flick that asked for the end is known to have done so
   * even when a burst of text lands in the same frame as its scroll.
   */
  const steer = useCallback(
    (delta: number) => {
      const state = follow.current
      const now = performance.now()
      const up = delta < 0
      const previous = state.intent
      const continued = previous?.up === up && now - previous.at < INTENT_MS
      const reach = (continued ? previous.reach : state.knownTop) + delta
      state.intent = { up, at: now, reach, toEnd: !up && reach >= endOf() - END_TOLERANCE_PX }
      if (up) glide.stop()
    },
    [endOf, glide],
  )
  const onWheel = useCallback(
    (event: ReactWheelEvent) => {
      // The user steering in any way ends a running jump on the spot.
      stopJump()
      if (event.deltaY === 0) return
      const unit =
        event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? follow.current.clientHeight : 1
      steer(event.deltaY * unit)
    },
    [steer, stopJump],
  )
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      stopJump()
      // Keys typed into a field inside the transcript move a caret, not the view.
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      const step = scrollKeyStep(event, follow.current.clientHeight)
      if (step !== undefined) steer(step)
    },
    [steer, stopJump],
  )

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop
    const state = follow.current
    // Our own corrections are not the user's opinion. The event that lands
    // where we wrote is ours; anything else is a real gesture.
    if (writtenScrollTop.current !== undefined && Math.abs(top - writtenScrollTop.current) < 1) {
      writtenScrollTop.current = undefined
      state.knownTop = top
      return
    }
    writtenScrollTop.current = undefined
    const mode = modeRef.current
    const moved = top - state.knownTop
    state.knownTop = top
    const intent =
      state.intent && performance.now() - state.intent.at < INTENT_MS ? state.intent : undefined
    const distance = endOf() - top
    // At the settled end the follow aims for, or at the raw scroll limit,
    // where the browser clamps a glide that ran ahead of a commit.
    const atEnd = distance <= END_TOLERANCE_PX || el.scrollHeight - top - el.clientHeight <= 1
    let nextMode: ScrollMode = mode
    if (atEnd) nextMode = 'follow-end'
    else if (mode === 'follow-end') {
      // Only a move up is the user taking over. A glide trails the end, the
      // virtual list corrects for rows it measured, and the end moves away
      // with every line; none of that leaves the follow. isAtBottom's 80px
      // slack is for starting a turn and must not trap a small gesture here.
      if (moved < -2 || (intent?.up === true && moved < 0)) nextMode = 'free'
    } else if (
      (moved > 0 || intent?.up === false) &&
      (distance <= REENGAGE_PX || intent?.toEnd === true)
    ) {
      // Heading back down and nearly there, or sent to the end. A wheel fixes
      // its target when it starts, so it lands short of an end that kept
      // moving; that is still the user asking to follow, and the glide closes
      // the rest.
      nextMode = 'follow-end'
    } else if (mode === 'reveal-hold') nextMode = 'free'
    if (nextMode === 'free') glide.stop()
    else if (glide.running) glide.sync(top)
    if (mode !== nextMode) {
      // Update the ref before the next streamed chunk can run the layout
      // effect and pull the viewport back to the end.
      modeRef.current = nextMode
      setMode(nextMode)
      if (nextMode === 'follow-end') catchUp(el)
    }
    updateJump(distance)
    if (canLoadOnScroll() && nearOlderHistoryEdge(el)) void loadOlder()
  }, [canLoadOnScroll, catchUp, endOf, glide, loadOlder, updateJump])

  // Ctrl+F cannot work with a virtualised list — the match may not be in the
  // DOM — so the app owns find instead of the browser.
  useEffect(() => {
    if (props.keyboardActive === false) return
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (matchesShortcut(event, FIND_IN_CHAT_SHORTCUT)) {
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

  const projectRepeatedDesignRows = useMemo(createRepeatedDesignRowProjector, [props.threadId])
  const repeatedDesignRowAt = projectRepeatedDesignRows(thread.items)
  estimateRow.current = (index) => {
    const item = thread.items[index]
    return item
      ? estimateThreadRowSize(item, index, presentations.get(item.turnId))
      : DEFAULT_ROW_ESTIMATE
  }
  const checkpoints = thread.running ? EMPTY_CHECKPOINTS : (props.checkpoints ?? EMPTY_CHECKPOINTS)
  const checkpointIndex = useMemo(() => createCheckpointIndex(checkpoints), [checkpoints])
  const searchJumpRead = useRef<{ request: number; cursor: string } | undefined>(undefined)
  // The older-history hook stops waiting for the complete read when its effects
  // are torn down, which StrictMode also does on mount; the next run must ask again.
  useEffect(
    () => () => {
      searchJumpRead.current = undefined
    },
    [props.threadId],
  )
  useEffect(() => {
    const target = props.searchJump
    if (!target || completedSearchJump.current === target.request) return
    const index = thread.items.findIndex((item) => item.turnId === target.turnId)
    if (index < 0) {
      // Ask once per jump and cursor. Structural updates keep arriving while
      // the read is out, and after a failure the retry is the reader's call.
      const cursor = thread.olderCursor
      const asked = searchJumpRead.current
      if (cursor && (asked?.request !== target.request || asked.cursor !== cursor)) {
        searchJumpRead.current = { request: target.request, cursor }
        loadComplete()
      }
      return
    }
    completedSearchJump.current = target.request
    setFinding(false)
    setMode('free')
    virtualizer.scrollToIndex(index, { align: 'center' })
    // This instance remembers the jump, but the next entry to the chat mounts a
    // new one; without this the old hit would be jumped to again every time.
    searchJumpDone.current?.(target.request)
  }, [thread.items, thread.olderCursor, props.searchJump, virtualizer, loadComplete])

  // Alt+Up/Down moves a turn at a time. Scrolling by pixel through a long
  // session to find where an exchange began is the slow way to do it.
  useEffect(() => {
    if (props.keyboardActive === false) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return
      if (
        !matchesShortcut(event, PREVIOUS_TURN_SHORTCUT) &&
        !matchesShortcut(event, NEXT_TURN_SHORTCUT)
      )
        return
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

  const anchor = prepend.current
  if (anchor && anchor.grown === undefined) {
    // Reveal-hold reads growth past the held height as new content below;
    // rows arriving above are not that.
    anchor.grown = virtualizer.getTotalSize() - anchor.previousSize
    heldHeight.current += anchor.grown
  }
  if (anchor?.index !== undefined && anchor.top === undefined) {
    virtualizer.getTotalSize()
    const start = virtualizer.measurementsCache[anchor.index]?.start
    if (start !== undefined) anchor.top = Math.max(0, start + anchor.offset!)
  }
  if (anchor?.top !== undefined && !anchor.applied) virtualizer.scrollOffset = anchor.top
  const rows = virtualizer.getVirtualItems()

  useLayoutEffect(() => {
    const anchor = prepend.current
    if (!anchor || anchor.items !== thread.items || anchor.applied) return
    anchor.applied = true
    const el = scroller.current
    // The virtualizer may already have corrected its offset for newly
    // measured rows above the fold during this commit; follow its value.
    if (el && anchor.top !== undefined) writeScrollTop(el, virtualizer.scrollOffset ?? anchor.top)
  }, [props.threadId, thread.items, virtualizer, writeScrollTop])

  useEffect(() => {
    const el = scroller.current
    if (!el || !thread.olderCursor || props.loading || thread.items.length === 0) return
    if (olderHistory !== 'idle' || completeStatus === 'loading') return
    if (nearOlderHistoryEdge(el)) void loadOlder()
  }, [
    thread.olderCursor,
    thread.items.length,
    props.loading,
    olderHistory,
    completeStatus,
    loadOlder,
  ])

  // measureElement without a ResizeObserver entry returns the cached size, so
  // a disclosure that just changed its row's height has to hand over a fresh
  // measurement. Rounded like the observer's border box so the observer's own
  // notification a frame later finds nothing left to change.
  const measureRow = useCallback(
    (row: Element, header: Element | null) => {
      // Layout and scroll below are read with the rows mounted so far in
      // place, and where the list's last correction put the scroll.
      measureMountedRows()
      flushListScroll()
      const el = scroller.current
      const index = virtualizer.indexFromElement(row)
      const size = Math.round(row.getBoundingClientRect().height)
      // The runway still has the row's old height until resizeItem below;
      // the cache says by how much it will change.
      const delta = size - (virtualizer.measurementsCache[index]?.size ?? size)
      if (!el || delta === 0) {
        virtualizer.resizeItem(index, size)
        return
      }
      // Read before resizeItem: the virtualizer may correct the scroll for a
      // row it thinks is above the fold, and adding the shift below on top
      // of that would move the viewport twice.
      const from = el.scrollTop
      // Another toggle is not new content, even when the scroll cannot follow it.
      if (modeRef.current === 'reveal-hold') heldHeight.current += delta
      if (header) slideFollowingInRow(row, header, delta)
      // The text after the disclosure is what the user is reading, so it must
      // not move: the details open upward and the summary travels instead.
      // Scroll by the row's growth in the same step that commits the runway
      // height, then slide the runway back from the old offset on the
      // compositor over the same curve as the rows, so both share one clock.
      // When the scroll cannot follow (a thread shorter than its viewport,
      // closing at the very top) the rows below slide instead, which is the
      // only honest option left.
      const nextMax = Math.max(0, settledHeight(el) + delta - el.clientHeight)
      // The summary the user just clicked must stay on screen: it may rise to
      // the top edge or sink to the bottom edge, no further. Past that the
      // details push the text below instead, so a long reveal never scrolls
      // its own header — and its virtual row — out of view.
      const viewport = el.getBoundingClientRect()
      const headerBox = (header ?? row).getBoundingClientRect()
      const headerTop = headerBox.top - viewport.top
      const roomAbove = Math.max(0, headerTop - HEADER_MARGIN)
      const roomBelow = Math.max(0, viewport.height - headerTop - headerBox.height - HEADER_MARGIN)
      const shift = delta > 0 ? Math.min(delta, roomAbove) : Math.max(delta, -roomBelow)
      pendingEndAnchor.current = {
        from,
        target: Math.min(Math.max(from + shift, 0), nextMax),
        delta,
      }
      // Taking the size writes the runway's new height at once, and the
      // list's change notification applies the scroll above (syncFollow) and
      // starts everything that moved from where it was, before paint.
      virtualizer.resizeItem(index, size)
    },
    [flushListScroll, measureMountedRows, settledHeight, virtualizer],
  )

  // Keep the turn timer above its first response until the whole turn ends.
  // The anchor row reserves the rail's height as more content arrives.
  //
  // measurementsCache, not getOffsetForIndex: the latter clamps to the
  // maximum scroll offset, which is below the anchor row's true start
  // whenever the thread is shorter than the viewport.
  const railIndexRef = useRef(railIndex)
  railIndexRef.current = railIndex
  const railReserveRef = useRef(railReserve)
  railReserveRef.current = railReserve
  const rail = useRef<{ element: HTMLDivElement | null; offset: number | undefined }>({
    element: null,
    offset: undefined,
  })
  // Like the rows, the rail moves where the virtual list says, when it says:
  // rows above it change size without the transcript rendering.
  const placeRail = useCallback(() => {
    const { element, offset } = rail.current
    if (!element) return
    const index = railIndexRef.current
    // Without a response row, over the room the runway keeps at its end.
    const reserved = virtualizer.getTotalSize() - railReserveRef.current
    const next =
      index === undefined ? reserved : (virtualizer.measurementsCache[index]?.start ?? reserved)
    if (next === offset) return
    rail.current.offset = next
    element.style.transform = `translateY(${next}px)`
  }, [virtualizer])
  const setRail = useCallback(
    (element: HTMLDivElement | null) => {
      rail.current = { element, offset: undefined }
      placeRail()
    },
    [placeRail],
  )
  useLayoutEffect(placeRail)

  /**
   * Keeps the viewport where the mode wants it after the transcript changed
   * size: after every commit and streamed frame (FrameScrollFollower) and
   * whenever the virtual list measured a row. Reads no layout in follow-end.
   */
  const syncFollow = useCallback(() => {
    const element = scroller.current
    if (!element) return
    // Everything below starts from where the list's last correction put the scroll.
    flushListScroll()
    const state = follow.current
    state.total = virtualizer.getTotalSize()
    sizeRunwayNow()

    // A disclosure just changed its row's height: apply its scroll (see
    // measureRow), whatever the mode.
    const anchor = pendingEndAnchor.current
    if (anchor) {
      pendingEndAnchor.current = undefined
      // The room gives way first: while a pinned answer is shorter than the
      // screen, details open into it and the end stays where it is. The
      // scroll below is then clamped to that end, and recorded as ours.
      applyRoom()
      writeScrollTop(element, anchor.target)
      // Not the scroll position read here: a shrinking runway has already
      // clamped it by the time this runs, which would hide the shift.
      const shift = element.scrollTop - anchor.from
      const settled = settledHeight(element)
      measureFollow(element, settled)
      const atEnd = settled + state.room - element.scrollTop - element.clientHeight <= 1
      // Opening something taller than the space above it leaves the viewport
      // short of the end. That was the user's choice; following the end now
      // would drag the summary they just clicked out of view. They did not
      // scroll away either, so hold without offering a jump.
      const next: ScrollMode | undefined = atEnd
        ? modeRef.current === 'free' || modeRef.current === 'reveal-hold'
          ? 'follow-end'
          : undefined
        : modeRef.current === 'free'
          ? undefined
          : 'reveal-hold'
      if (next === 'reveal-hold') heldHeight.current = settled
      if (next && next !== modeRef.current) {
        modeRef.current = next
        setMode(next)
      }
      if (runwayRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        slideTranscript(runwayRef.current, shift, anchor.delta)
      }
      return
    }

    // A chat follows once it has been opened at its end.
    if (openedThread.current?.threadId !== threadIdRef.current) return
    if (!state.measured) measureFollow(element)
    // Whatever the mode: a pinned answer grows into its room, so the scroll
    // height holds still for someone reading above it too.
    applyRoom()

    if (modeRef.current === 'follow-end') {
      // From the virtual total and what the last resize measured, never from
      // layout: this runs for every streamed frame. Settled, never
      // scrollHeight: a render during a disclosure's slide lands here while
      // the runway or a closing reveal still extends the scrollable overflow.
      followTo(element, endOf())
      return
    }

    if (modeRef.current === 'reveal-hold') {
      // Something new arrived below the details: now there is a latest to jump to.
      if (settledHeight(element) > heldHeight.current + 1) {
        modeRef.current = 'free'
        setMode('free')
        updateJump(endOf() - state.knownTop)
      }
      return
    }

    // Free: the end keeps moving away while the user reads above it.
    updateJump(endOf() - state.knownTop)
  }, [
    applyRoom,
    endOf,
    flushListScroll,
    followTo,
    measureFollow,
    settledHeight,
    sizeRunwayNow,
    updateJump,
    virtualizer,
    writeScrollTop,
  ])
  runVirtualFlush.current = () => {
    measureMountedRows()
    flushListScroll()
    const flush = virtualFlush.current
    if (!flush.follow) return
    flush.follow = false
    if (virtualizer.getTotalSize() !== follow.current.total) syncFollow()
  }
  virtualChanged.current = () => {
    placeRail()
    // Scrolling changes the rows shown too; only a new total moved anything.
    if (virtualizer.getTotalSize() === follow.current.total) return
    // A disclosure applies its scroll in the step that took its size (measureRow).
    if (pendingEndAnchor.current) {
      syncFollow()
      return
    }
    // One ResizeObserver callback measures many rows, and each notifies.
    // Followed row by row, every follow read the layout the row before had
    // just changed; once at the end of the task is enough.
    virtualFlush.current.follow = true
    queueVirtualFlush()
  }

  // The reading position changes on purpose at two moments: when the user
  // asks for the end of the chat they are in (sending a message, picking the
  // open chat again), and when a turn starts. Opening another chat lands on
  // its end by itself (FrameScrollFollower) and counts its request as done.
  //
  // Watch a turn's first item rather than the running boolean: a queued turn
  // can start in the same render batch that the previous turn completes,
  // leaving `running` true throughout. The submission id also survives the
  // local -> durable handoff, so provider confirmation does not cause a
  // second move.
  //
  // Someone following the end keeps following it, with the new prompt pinned
  // near the top: the answer fills the screen below it without anything
  // moving, then the follow glides after it. Before the first paint of the
  // prompt, so the glide up starts from where the prompt appeared.
  useLayoutEffect(() => {
    const el = scroller.current
    const state = follow.current
    // What follows reads the scroll where the list's last correction put it.
    flushListScroll()
    const request = props.revealRequest ?? 0
    const revealed = completedRevealRequest.current !== request
    completedRevealRequest.current = request
    if (revealed && modeRef.current !== 'follow-end') {
      modeRef.current = 'follow-end'
      setMode('follow-end')
    }

    let started = false
    if (anchoredTurn.current.threadId !== props.threadId) {
      anchoredTurn.current = { threadId: props.threadId, itemId: activeAnchor?.id }
    } else if (!running) {
      anchoredTurn.current.itemId = undefined
    } else if (activeAnchor && anchoredTurn.current.itemId !== activeAnchor.id) {
      started = true
      anchoredTurn.current.itemId = activeAnchor.id
      anchorIndex.current = activeAnchor.index
      // The prompt is already in the runway, so a long one would put the end
      // out of isAtBottom's reach; the mode says whether the user followed.
      const following = modeRef.current !== 'free' || !el || isAtBottom(el)
      const next = modeForNewTurn(following)
      state.pinned = following
      if (next !== modeRef.current) {
        modeRef.current = next
        setMode(next)
      }
    }
    if (!el || !(revealed || started)) return
    if (modeRef.current === 'follow-end') {
      if (!state.measured) measureFollow(el)
      applyRoom()
      // Within a couple of screens the way there glides; from further up it
      // lands at once, as a long glide would only blur past the chat.
      const end = endOf()
      if (Math.abs(end - state.knownTop) > REVEAL_GLIDE_SCREENS * state.clientHeight) {
        writeScrollTop(el, end)
      }
    }
    syncFollow()
  }, [
    activeAnchor,
    applyRoom,
    endOf,
    flushListScroll,
    measureFollow,
    props.revealRequest,
    props.threadId,
    running,
    syncFollow,
    writeScrollTop,
  ])
  // Find shows its own read in the find bar; a search jump's read shows here.
  const completeFailed = !finding && completeStatus === 'failed'
  const olderPill =
    olderHistory === 'loading' || (!finding && completeStatus === 'loading')
      ? 'loading'
      : olderHistory === 'failed' || completeFailed
        ? 'failed'
        : 'idle'
  // While find reads the rest of the chat, the find bar's status speaks for
  // both reads; two live regions at once would talk over each other.
  const olderAnnouncement = finding && completeStatus === 'loading' ? 'idle' : olderPill

  return (
    // The overlays live OUTSIDE the scroller: an absolutely positioned child
    // of a scroll container scrolls away with the content — Ctrl+F used to
    // yank the transcript to the top just to show the find bar, and "Jump to
    // latest" rendered below the viewport exactly when it was needed.
    <RowMeasureContext.Provider value={measureRow}>
      <div className="thread-shell">
        {finding ? (
          <Suspense fallback={<FindBarSkeleton />}>
            <ThreadSearch
              items={thread.items}
              liveItems={liveItems}
              frameStore={props.frameStore}
              threadId={props.threadId}
              hasOlder={thread.olderCursor !== undefined}
              olderStatus={completeStatus}
              onLoadOlder={loadComplete}
              onJump={jumpTo}
              onClose={closeFind}
            />
          </Suspense>
        ) : null}
        {thread.items.length === 0 && !running ? (
          props.loading ? (
            <ThreadSkeleton className="thread__empty" />
          ) : props.loadFailure !== undefined ? (
            <div className="empty thread__empty" role="alert">
              <div className="empty__prompt" role="heading" aria-level={1}>
                This chat could not be loaded.
              </div>
              {props.loadFailure ? <p className="empty__detail">{props.loadFailure}</p> : null}
              {props.onRetryLoad ? (
                <button className="btn" type="button" onClick={props.onRetryLoad}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : (
            <div className="empty thread__empty">
              <div className="empty__prompt" role="heading" aria-level={1}>
                Tell the agent what you want to build, then send it below.
              </div>
            </div>
          )
        ) : null}
        <div
          className="thread"
          ref={scroller}
          onScroll={onScroll}
          // The user steering in any way ends a running jump on the spot.
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onTouchStart={onTouchStart}
          onKeyDown={onKeyDown}
        >
          <div className="thread__col">
            <div className="thread__runway" ref={setRunway}>
              {rows.map((row) => {
                const item = threadItemAt(thread.items, liveItems, row.index)
                if (!item) return null
                const presentation = presentations.get(item.turnId)
                const activityGroup = presentation
                  ? activityGroupAt(presentation.activityGroups, row.index)
                  : undefined
                return (
                  <ThreadFrameRow
                    key={row.key}
                    index={row.index}
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
                // sits at the end of the runway, over the room the runway
                // keeps there (railReserve).
                <div className="thread__rail" ref={setRail}>
                  {activePresentation?.design ? (
                    <FrameWorkingRail
                      frameStore={props.frameStore}
                      items={thread.items}
                      turnId={thread.activeTurn.id}
                      liveStart={thread.liveStart}
                      activityIndices={activeActivityIndices}
                      startedAt={activePresentation.workStartedAt}
                    />
                  ) : (
                    <TurnDuration startedAt={thread.activeTurn.startedAt} />
                  )}
                </div>
              ) : null}
            </div>

            {/* Above the plan and the diff: it is the only thing here that blocks
            the agent, so it should be the first thing the eye lands on. */}
            {thread.userInputs.map((request) => (
              <UserInput
                key={request.id}
                request={request}
                inline={props.inlineUserInput}
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
          {/* Blank room below a pinned prompt's answer; see applyRoom. */}
          <div className="thread__turn-room" ref={roomRef} aria-hidden />
        </div>

        {/* Mount after the scroller so its ref is set before the layout effect. */}
        <FrameScrollFollower
          frameStore={props.frameStore}
          threadId={props.threadId}
          revealRequest={props.revealRequest ?? 0}
          completedRevealRequest={completedRevealRequest}
          openedThread={openedThread}
          scroller={scroller}
          modeRef={modeRef}
          pendingEndAnchor={pendingEndAnchor}
          running={running}
          follow={follow}
          writeScrollTop={writeScrollTop}
          followTo={followTo}
          measureFollow={measureFollow}
          settledHeight={settledHeight}
          applyRoom={applyRoom}
          syncFollow={syncFollow}
          measureMountedRows={measureMountedRows}
          endOf={endOf}
          updateJump={updateJump}
          setMode={setMode}
        />

        {/* Mounted for as long as older turns exist: a live region announces
            changes to its text, not its own arrival. The pills below stay
            out of the reading. */}
        {thread.olderCursor ? (
          <div className="visually-hidden" role="status">
            {olderAnnouncement === 'loading'
              ? 'Loading earlier messages'
              : olderAnnouncement === 'failed'
                ? 'Couldn’t load earlier messages'
                : ''}
          </div>
        ) : null}
        {thread.olderCursor && olderPill === 'loading' ? (
          <div className="thread__older" aria-hidden>
            <LoaderCircle className="spinner" aria-hidden />
            Loading earlier messages
          </div>
        ) : null}
        {thread.olderCursor && olderPill === 'failed' ? (
          <button
            className="thread__older"
            onClick={() => (completeFailed ? loadComplete() : void loadOlder())}
          >
            <RotateCcw size={13} aria-hidden />
            Couldn’t load earlier messages. Retry
          </button>
        ) : null}

        {mode === 'free' && jumpShown ? (
          <button className="jump" onClick={jumpToLatest}>
            <ArrowDownToLine size={13} aria-hidden />
            Jump to latest
          </button>
        ) : null}
      </div>
    </RowMeasureContext.Provider>
  )
})

/**
 * Follow-scroll needs every text frame, but the virtual list does not. Keep
 * that small imperative update in its own subscriber so growing one live row
 * never rerenders the transcript owner or reprojects the full thread.
 */
function FrameScrollFollower({
  frameStore,
  threadId,
  revealRequest,
  completedRevealRequest,
  openedThread,
  scroller,
  modeRef,
  pendingEndAnchor,
  running,
  follow,
  writeScrollTop,
  followTo,
  measureFollow,
  settledHeight,
  applyRoom,
  syncFollow,
  measureMountedRows,
  endOf,
  updateJump,
  setMode,
}: {
  frameStore: ThreadFrameStore
  threadId: string | undefined
  revealRequest: number
  completedRevealRequest: { current: number }
  openedThread: { current: { threadId: string | undefined } | undefined }
  scroller: { current: HTMLDivElement | null }
  modeRef: { current: ScrollMode }
  pendingEndAnchor: { current: EndAnchor | undefined }
  running: boolean
  follow: { current: FollowState }
  writeScrollTop: (element: HTMLElement, top: number) => void
  followTo: (element: HTMLElement, end: number) => void
  measureFollow: (element: HTMLElement, settled?: number) => void
  settledHeight: (element: HTMLElement) => number
  applyRoom: () => void
  syncFollow: () => void
  measureMountedRows: () => void
  endOf: () => number
  /** Offers or withdraws Jump to latest for the end's distance while free. */
  updateJump: (distance: number) => void
  setMode: (mode: ScrollMode) => void
}) {
  const getVersion = useCallback(() => frameStore.getSnapshot().itemVersion, [frameStore])
  useSyncExternalStore(frameStore.subscribe, getVersion, getVersion)

  // Images and change previews can resize below the virtual list without a
  // transcript render. Keep the end pinned until the user takes over.
  useLayoutEffect(() => {
    const element = scroller.current
    const content = element?.firstElementChild
    if (!element || !content) return
    const observer = new ResizeObserver(() => {
      // Layout is clean here, so this is where what surrounds the runway is
      // measured. Settled, not scrollHeight: this fires right after a
      // disclosure commits, while its reveal and the runway are still mid-slide.
      const viewport = follow.current.clientHeight
      measureFollow(element)
      applyRoom()
      if (modeRef.current === 'free') updateJump(endOf() - follow.current.knownTop)
      if (modeRef.current !== 'follow-end') return
      // A viewport that changed size keeps the last line where it was at
      // once: a composer growing by a line must not cover it while a glide
      // catches up.
      if (follow.current.clientHeight !== viewport) writeScrollTop(element, endOf())
      else followTo(element, endOf())
    })
    observer.observe(element)
    observer.observe(content)
    return () => observer.disconnect()
  }, [
    scroller,
    modeRef,
    follow,
    writeScrollTop,
    followTo,
    measureFollow,
    applyRoom,
    endOf,
    updateJump,
  ])

  // Follow every render before paint: replay and virtual row measurements can
  // change the scroll height without changing the live text frame version.
  useLayoutEffect(() => {
    // The rows of this commit are all attached now: they take their sizes
    // before the end below is opened or followed.
    measureMountedRows()
    const state = follow.current
    const now = performance.now()
    // The end glides while a turn runs, and a moment after it: the reply
    // still settles into its final form once streaming stops.
    if (running) state.liveUntil = Number.POSITIVE_INFINITY
    else if (state.liveUntil === Number.POSITIVE_INFINITY) state.liveUntil = now + FOLLOW_SETTLE_MS
    const element = scroller.current
    if (!element) return

    if (
      pendingEndAnchor.current === undefined &&
      (openedThread.current === undefined || openedThread.current.threadId !== threadId)
    ) {
      // Opening a chat lands on its end in one step. The rows measure
      // themselves in over the next frames; those corrections are not motion
      // anyone should watch, so they are written at once too.
      openedThread.current = { threadId }
      // The chat opens at its own end; no earlier turn's room comes along.
      state.pinned = false
      applyRoom()
      // Landing on the end is what a request that came with the chat asked for.
      completedRevealRequest.current = revealRequest
      state.instantUntil = now + OPEN_SETTLE_MS
      modeRef.current = 'follow-end'
      setMode('follow-end')
      const settled = settledHeight(element)
      measureFollow(element, settled)
      writeScrollTop(element, settled - element.clientHeight)
      return
    }

    syncFollow()
  })

  return null
}

/** A scroll correction the virtual list asked for: its offset and the adjustment on top. */
type ListScroll = {
  offset: number
  adjustments: number
  instance: Virtualizer<HTMLDivElement, Element>
}

/** What the follow logic knows about the scroller without reading layout per frame. */
type FollowState = {
  /** The scroll position last written or reported by a scroll event. */
  knownTop: number
  /** Whether `extra` and `clientHeight` have been read yet. */
  measured: boolean
  /** Scroll height beyond the runway: what follows the rows, and the padding. */
  extra: number
  clientHeight: number
  /** The virtual total the follow last acted on; a list change that keeps it moved nothing. */
  total: number
  /** Where the transcript's first row starts in the scroll: the scroller's top padding. */
  contentTop: number
  /**
   * The turn at anchorIndex started while the user followed the end: its
   * prompt holds the end near the top until its answer fills the screen.
   */
  pinned: boolean
  /** Blank room written below the transcript so the pinned end can be reached. */
  room: number
  /** The end glides until this time; open while a turn runs. */
  liveUntil: number
  /** Every follow is a plain write until this time. */
  instantUntil: number
  /** A pointer or finger is down on the transcript. */
  holding: boolean
  /** The user's last wheel turn or scroll key: which way, when, and how far. */
  intent:
    | {
        up: boolean
        at: number
        /** Where the gesture asked the scroll to go. */
        reach: number
        /** It asked for the end, or past it. */
        toEnd: boolean
      }
    | undefined
}

/** Where the viewport stood when older rows were prepended above it. */
type PrependAnchor = {
  items: Item[]
  applied: boolean
  /** The runway height before the rows arrived. */
  previousSize: number
  /** How much the runway grew, once measured against the new rows. */
  grown?: number
  index?: number
  offset?: number
  top?: number
}

/** A disclosure's row height change, waiting for the runway to commit it. */
type EndAnchor = {
  /** The scroll position before the commit. */
  from: number
  target: number
  delta: number
}

/** Time constant of the jump glide: about 95% of the way after 3x this. */
const JUMP_EASE_MS = 110
/** The slowest the jump glide moves, about 13px per frame at 60 Hz. */
const JUMP_MIN_PX_PER_MS = 0.8
/** Closer than this the minimum speed would dominate; the follow glide lands instead. */
const JUMP_HANDOVER_PX = JUMP_MIN_PX_PER_MS * JUMP_EASE_MS
/** How long after a turn ends its last changes still glide into view. */
const FOLLOW_SETTLE_MS = 1_200
/** The working rail's footprint above its turn's first response: --working-rail-h in thread.css. */
const WORKING_RAIL_PX = 42
/** How long after a chat opens its rows are still measuring themselves in. */
const OPEN_SETTLE_MS = 400
/** A requested end at most this many viewports away glides there; a further one is written at once. */
const REVEAL_GLIDE_SCREENS = 2
/** How long a wheel turn or scroll key still explains the scroll events after it. */
const INTENT_MS = 250
/** Within this of the end the viewport counts as at the end. */
const END_TOLERANCE_PX = 2
/** A scroll heading down that lands this close to the end follows it again. */
const REENGAGE_PX = 56
/** Jump to latest appears past this distance from the end... */
const JUMP_SHOW_PX = 160
/** ...and goes once the end is closer than this again. */
const JUMP_HIDE_PX = 96
const POINTER_RELEASE = ['pointerup', 'pointercancel'] as const
const TOUCH_RELEASE = ['touchend', 'touchcancel'] as const

/** The browser's step for a wheel line and an arrow key. */
const LINE_PX = 40

/** How far a key scrolls the transcript, negative for up, if it scrolls at all. */
function scrollKeyStep(
  event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  viewport: number,
): number | undefined {
  // Alt+Arrow moves by turn and says so itself; the others are not scrolling.
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined
  const page = Math.max(LINE_PX, viewport * 0.875)
  switch (event.key) {
    case 'ArrowUp':
      return -LINE_PX
    case 'ArrowDown':
      return LINE_PX
    case 'PageUp':
      return -page
    case 'PageDown':
      return page
    case ' ':
      return event.shiftKey ? -page : page
    case 'Home':
      return Number.NEGATIVE_INFINITY
    case 'End':
      return Number.POSITIVE_INFINITY
    default:
      return undefined
  }
}

const ITEM_ENTRY_MS = 360
const TURN_SETTLE_MS = 520

/**
 * The scroll height once the running reveal and slide animations settle.
 * scrollHeight also counts boxes that are mid-animation — a closing reveal
 * still hanging below its summary, the runway starting its slide below its
 * place — so during a toggle it puts the end further away than it will be.
 * The column's own box is in-flow layout only and never transformed.
 */
function settledScrollHeight(element: HTMLElement): number {
  const height = element.firstElementChild?.getBoundingClientRect().height ?? 0
  // No layout box yet: nothing is animating either.
  if (height === 0) return element.scrollHeight
  const style = getComputedStyle(element)
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  return Math.min(element.scrollHeight, Math.round(height + padding))
}

/**
 * The scroll just moved by `shift` and the runway's height by `delta`, both
 * in one step. Start everything that jumped where it was on screen and let it
 * settle over the reveal's own curve: the runway carries the rows above the
 * disclosure, and whatever follows the transcript (plan, approvals, diff)
 * travels with the rows below it. A reversal mid-flight keeps whatever offset
 * the previous slide had left to unwind.
 */
function slideTranscript(runway: HTMLElement, shift: number, delta: number) {
  const opening = delta > 0
  if (shift !== 0) slideFrom(runway, shift, opening)
  if (Math.abs(shift - delta) < 1) return
  for (let next = runway.nextElementSibling; next; next = next.nextElementSibling) {
    if (next instanceof HTMLElement) slideFrom(next, shift - delta, opening)
  }
}

/**
 * Rows after a disclosure glide on their own transform, but content later in
 * the same row moves with layout in one step. Start that content where it was
 * and let it travel over the reveal's curve, so everything below the summary
 * moves as one piece whether or not the scroll could follow.
 */
function slideFollowingInRow(row: Element, header: Element, delta: number) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  for (let node = header.parentElement; node && node !== row; node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next instanceof HTMLElement) slideFrom(next, -delta, delta > 0)
    }
  }
}

const REVEAL_SLIDE = 'reveal-slide'

/** A reversal mid-flight keeps whatever offset the previous slide had left. */
function slideFrom(element: HTMLElement, offset: number, opening: boolean) {
  const running = element.getAnimations().find((animation) => animation.id === REVEAL_SLIDE)
  const current = running ? new DOMMatrix(getComputedStyle(element).transform).m42 : 0
  running?.cancel()
  element.animate([{ transform: `translateY(${current + offset}px)` }, { transform: 'none' }], {
    id: REVEAL_SLIDE,
    duration: opening ? REVEAL_OPEN_MS : REVEAL_CLOSE_MS,
    easing: REVEAL_EASING,
  })
}

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
  const compactedActivity = isCompactedActivity(item, index, presentation, activityGroup)
  const activityLead = compactedActivity && activityGroup?.firstIndex === index
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
    nextVisibleItem !== undefined &&
    (nextVisibleItem.turnId === item.turnId ||
      (item.type === 'message' &&
        item.role === 'assistant' &&
        item.id.startsWith('design-not-applicable-'))) &&
    !(item.type === 'message' && item.role === 'user') &&
    !(nextVisibleItem.type === 'message' && nextVisibleItem.role === 'user')
  const settling = settlingTurnId === item.turnId
  const railAnchor = showWorkingRail && live && presentation?.firstResponseIndex === index
  const activityComplete = presentation?.complete === true && !live && presentation.design !== true
  const activitySource =
    activityLead && activityGroup
      ? {
          group: activityGroup,
          items,
          liveItems,
          complete: activityComplete,
          stopped: activityComplete && presentation.stopped,
        }
      : undefined
  const liveItemUpdate = liveItems.get(index)
  // A restart also ends a turn as interrupted; its error row says why, so the
  // turn does not claim the user stopped it.
  const stoppedByUser =
    !live &&
    presentation?.stopped === true &&
    presentation.endIndex === index &&
    threadItemAt(items, liveItems, presentation.lastIndex + 1)?.type !== 'error'
  // An answer carries its marker under its text, above its actions.
  const stoppedAnswer = stoppedByUser && item.type === 'message' && item.role === 'assistant'

  return (
    <div
      className={`thread__row${suppressed ? ' is-suppressed' : ''}${compactToNext ? ' is-compact-to-next' : ''}${entering ? ' is-entering' : ''}${settling ? ' is-settling' : ''}${railAnchor ? ' is-rail-anchor' : ''}`}
      data-index={index}
      // The virtual list writes the row's position itself (directDomUpdates).
      ref={measureElement}
    >
      {responseLead && !presentation.design && presentation.activityGroups.length === 0 ? (
        <TurnDuration elapsedMs={presentation.elapsedMs} stopped={presentation.stopped} />
      ) : null}
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
        checkpoint={checkpointForItem(presentation?.prompt ?? item, checkpointIndex, items)}
        onRevertCheckpoint={onRevertCheckpoint}
        stoppedByUser={stoppedAnswer}
      />
      {stoppedByUser && !stoppedAnswer ? <TurnStopped /> : null}
    </div>
  )
})

/** Roughly one paragraph, for rows whose height depends on their text. */
const DEFAULT_ROW_ESTIMATE = 72
/** A collapsed one-line work summary: its 30px line, 8px margin and the row gap. */
const COLLAPSED_ACTIVITY_ESTIMATE = 46

/** Whether this row belongs to a work disclosure that another row renders. */
function isCompactedActivity(
  item: Item,
  index: number,
  presentation: TurnPresentation | undefined,
  activityGroup: TurnActivityGroup | undefined,
): boolean {
  return (
    activityGroup !== undefined &&
    (isStackedActivity(item) ||
      (presentation?.complete === true &&
        isWorkDisclosureItem(item) &&
        index !== presentation.finalAnswerIndex))
  )
}

/**
 * The height a row is expected to measure before it has rendered. Only the
 * lead row of a work disclosure renders, so every other row in it measures 0.
 */
export function estimateThreadRowSize(
  item: Item,
  index: number,
  presentation: TurnPresentation | undefined,
): number {
  if (isBlankReasoning(item)) return 0
  const activityGroup = presentation
    ? activityGroupAt(presentation.activityGroups, index)
    : undefined
  if (isCompactedActivity(item, index, presentation, activityGroup)) {
    return activityGroup?.firstIndex === index ? COLLAPSED_ACTIVITY_ESTIMATE : 0
  }
  if (isActivity(item)) return COLLAPSED_ACTIVITY_ESTIMATE
  return DEFAULT_ROW_ESTIMATE
}

/** Bounds the walk past hidden rows so a huge collapsed batch stays cheap. */
const MAX_OVERSCAN_WALK = 256

/**
 * The rows to mount: the visible range plus `overscan` rows on each side that
 * actually take up space. Most rows inside a work disclosure measure 0, and
 * counting them would leave no real margin: a disclosure just above the
 * viewport could unmount for one frame while it collapses, losing its state.
 */
export function overscanVisibleRows(
  range: Range,
  sizeOf: (index: number) => number | undefined,
): number[] {
  const step = (from: number, direction: 1 | -1, last: number) => {
    let index = from
    for (let seen = 0, walked = 0; index !== last && seen < range.overscan; walked++) {
      if (walked >= MAX_OVERSCAN_WALK) break
      index += direction
      if ((sizeOf(index) ?? 1) > 0) seen++
    }
    return index
  }
  const start = step(range.startIndex, -1, 0)
  const end = step(range.endIndex, 1, Math.max(0, range.count - 1))
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
}

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
  return item.type !== 'message' && item.type !== 'error' && item.type !== 'notice'
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
  stoppedByUser = false,
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
  /** The answer of a turn the user stopped ends on the stopped marker. */
  stoppedByUser?: boolean
}) {
  if (hidden) return null

  // The working rail already announces the running design phase by name; a
  // second row with the same label reads as a duplicate. The row appears once
  // the phase completes, with its duration.
  if (item.type === 'tool_call' && item.status === 'started' && designPhaseLabel(toolText(item))) {
    return null
  }

  if (activity) {
    // A batch of one would only repeat its call; the call is the row.
    const lone = !activityLive && !activity.complete ? loneToolCall(activity) : undefined
    if (lone) return <ActivityRow key={lone.id} item={lone} live={false} />
    return (
      <ActivityStack
        key={activity.complete ? 'complete' : 'working'}
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
            <CopyButton text={item.text} label="Copy prompt" />
            {onEditMessage ? (
              <button
                type="button"
                onClick={() => onEditMessage(item.text!)}
                aria-label="Edit as new prompt"
                title="Edit as new prompt"
              >
                <Pencil aria-hidden />
              </button>
            ) : null}
            {checkpoint && onRevertCheckpoint ? (
              <button
                type="button"
                onClick={() => onRevertCheckpoint(checkpoint)}
                aria-label="Restore to before this prompt"
                title="Restore to before this prompt"
              >
                <History aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (item.type === 'message') {
    const text = responseText ?? item.text ?? ''
    const notice = item.id.startsWith('design-not-applicable-')
    return (
      <div className={`reply${notice ? ' reply--notice' : ''}${live ? ' is-streaming' : ''}`}>
        <Markdown
          text={text}
          projectPath={projectPath}
          streaming={live && item.status === 'started'}
          liveUpdate={liveTextUpdate}
          updateVersion={liveUpdateVersion}
          literalHtml
        />
        {stoppedByUser ? <TurnStopped /> : null}
        {finalResponse && !notice && !live && item.status === 'completed' && text ? (
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
    const raw = item.text ?? ''
    if (!/\S/.test(raw)) return null
    // Streamed Markdown appends a delta only when the text grew by exactly that delta.
    const text = live && item.status === 'started' ? raw : raw.trim()
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

  if (item.type === 'notice') return <NoticeRow item={item} />

  return <ActivityRow item={item} live={live} />
})

/** Where the chat moved to another provider; the turns after it ran there. */
function NoticeRow({ item }: { item: Item }) {
  const accountLabel = useContext(AccountLabelContext)
  const notice = item.notice
  if (notice?.kind !== 'provider') return null
  const label = providerNoticeLabel(notice, accountLabel)
  return (
    <div className="aux aux--notice" role="note">
      <div className="aux__row" title={label}>
        <span className="aux__glyph" aria-hidden>
          <ProviderIcon
            mark={
              notice.provider === 'acp' && notice.agent
                ? agentMark(notice.agent)
                : providerMark(notice.provider)
            }
            size={14}
          />
        </span>
        <span className="aux__label">{label}</span>
      </div>
    </div>
  )
}

export function providerNoticeLabel(notice: ProviderNotice, accountLabel?: AccountLabel): string {
  const provider =
    notice.provider === 'acp' && notice.agent ? notice.agent : providerDisplayName(notice.provider)
  // Another account of a provider is named, so a move between two accounts says where.
  const name =
    notice.accountId && accountLabel
      ? `${provider} (${accountLabel(notice.provider, notice.accountId)})`
      : provider
  return notice.model ? `Switched to ${name} · ${notice.model}` : `Switched to ${name}`
}

/** A call that started a subagent draws as that subagent; anything else as a plain row. */
function ActivityRow({ item, live }: { item: Item; live: boolean }) {
  return item.subagent ? <SubagentRow item={item} /> : <AuxDisclosure item={item} live={live} />
}

function loneToolCall(activity: ActivityRenderSource): Item | undefined {
  const items = activityItemsForRender(activity.group, activity.items, activity.liveItems)
  let lone: Item | undefined
  for (const item of items) {
    if (!isWorkDisclosureItem(item)) continue
    if (lone || !isStackedActivity(item)) return undefined
    lone = item
  }
  return lone
}

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
  complete: boolean
  /** A settled turn the user stopped: its summary says so instead of "Worked for". */
  stopped?: boolean | undefined
}

/**
 * What the live summary names. Reasoning that is still open counts even when
 * its summary is empty — some models never send one — because the alternative
 * is a row that keeps saying "Used …" in the past tense while the model thinks.
 */
function lastActivityItemForRender({
  group,
  items,
  liveItems,
}: ActivityRenderSource): Item | undefined {
  for (let index = group.lastIndex; index >= group.firstIndex; index -= 1) {
    const item = threadItemAt(items, liveItems, index)
    if (!item) continue
    if (isWorkDisclosureItem(item) || (item.type === 'reasoning' && item.status === 'started')) {
      return item
    }
  }
  return undefined
}

/**
 * A standalone operational row for activity that does not belong to a normal
 * tool stack, such as a design phase marker or an unknown provider item.
 */
function AuxDisclosure({ item, live }: { item: Item; live: boolean }) {
  const disclosure = useDisclosure()
  const phase = item.type === 'tool_call' && designPhaseLabel(toolText(item)) !== undefined
  // An open row needs its detail anyway, so the detail answers whether it has
  // any; a closed row asks without building it.
  const detail = useMemo(
    () => (!phase && disclosure.contentMounted ? auxDetail(item) : undefined),
    [item, phase, disclosure.contentMounted],
  )
  const expandable = !phase && (disclosure.contentMounted ? Boolean(detail) : hasAuxDetail(item))
  const label = live ? summariseLive(item) : activityItemLabel(item)

  return (
    <div
      className={`aux aux--${item.type}${phase ? ' aux--phase' : ''}${live ? ' aux--live' : ''}`}
      data-expanded={disclosure.expanded}
      data-failed={isFailedActivity(item)}
    >
      <button
        type="button"
        className="aux__row"
        aria-expanded={expandable ? disclosure.expanded : undefined}
        disabled={!expandable}
        title={label}
        onClick={disclosure.toggle}
      >
        <span className="aux__glyph" aria-hidden>
          {glyph(item)}
        </span>
        <span className="aux__label">{activityLabelParts(item, label)}</span>
        {item.type === 'file_change' ? <ItemChangeStats item={item} /> : null}
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
        {expandable ? (
          <ChevronRight className="aux__chevron" size={14} strokeWidth={1.8} aria-hidden />
        ) : null}
      </button>
      {/* Design markers have no output worth expanding — their text is the slug. */}
      {expandable ? (
        <div
          ref={disclosure.revealRef}
          className="aux__reveal"
          data-open={disclosure.dataOpen}
          aria-hidden={!disclosure.expanded}
          inert={!disclosure.expanded}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'transform')
              disclosure.finishTransition()
          }}
        >
          {detail ? (
            <div className="aux__reveal-clip">
              <AuxDetail item={item} detail={detail} active={disclosure.expanded} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** What a standalone row opens to, or nothing beyond its label. */
function auxDetail(item: Item): string | undefined {
  return item.type === 'command' || item.type === 'tool_call' || item.type === 'file_change'
    ? activityDetail(item)
    : isContextCompaction(item)
      ? undefined
      : (imageViewDetail(item) ?? item.text)
}

const auxDetailPresence = new WeakMap<Item, boolean>()

/**
 * Whether a closed row has detail to open, decided without building it. A
 * tool's output can be hundreds of kilobytes of JSON: arguments already answer
 * for almost every call, and any other row reads its output once per item
 * rather than on every render of the stack around it. Items are immutable; a
 * live update arrives as a new object. An open row builds its detail instead.
 */
function hasAuxDetail(item: Item): boolean {
  let present = auxDetailPresence.get(item)
  if (present === undefined) {
    present = hasToolArguments(item) || Boolean(auxDetail(item))
    auxDetailPresence.set(item, present)
  }
  return present
}

/** A tool call's arguments are part of its detail, so a call with any has detail. */
function hasToolArguments(item: Item): boolean {
  return (
    item.type === 'tool_call' &&
    !isContextCompaction(item) &&
    designPhaseLabel(toolText(item)) === undefined &&
    toolArgumentEntries(parseToolCall(item.text).args).length > 0
  )
}

/** Rendered only while its reveal is mounted, and not again on a parent render. */
const AuxDetail = memo(function AuxDetail({
  item,
  detail,
  active,
}: {
  item: Item
  detail: string
  active: boolean
}) {
  return isImageView(item) && item.status === 'completed' ? (
    <ViewedImagePreview reference={detail} active={active} fallbackClassName="aux__out" />
  ) : (
    <ActivityDetail item={item} detail={detail} className="aux__out" />
  )
})

/**
 * What opens under a tool row. A tool call shows what it was asked and what
 * it answered as two things, not one blob; a file change shows the diff the
 * way the turn summary does; everything else is the plain output.
 */
function ActivityDetail({
  item,
  detail,
  className,
}: {
  item: Item
  detail: string
  className: string
}) {
  if (item.type === 'file_change') {
    const diff = fileChangeDiff(item)
    if (diff) return <FileChangeDetail diff={diff} className={className} />
  }
  if (item.type === 'tool_call') {
    const call = parseToolCall(item.text)
    const entries = toolArgumentEntries(call.args)
    if (entries.length > 0 || call.output) {
      return (
        <div className={`${className} tool-detail`}>
          {entries.length > 0 ? (
            <dl className="tool-detail__args">
              {entries.map(([key, value]) => (
                <Fragment key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
          {call.output ? <pre className="tool-detail__output">{call.output}</pre> : null}
        </div>
      )
    }
  }
  return <pre className={className}>{detail}</pre>
}

function FileChangeDetail({
  diff,
  className,
}: {
  diff: ReturnType<typeof parseDiff>
  className: string
}) {
  return (
    <div className={`${className} change-detail`}>
      {diff.fileEntries.length > 1 ? (
        <ul className="change-detail__files">
          {diff.fileEntries.map((file, index) => (
            <li key={`${file.path}:${index}`}>
              <span className="change-detail__path">{file.path}</span>
              <ChangeStats
                added={file.added}
                removed={file.removed}
                className="change-detail__stat"
              />
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="change-detail__diff">
        {diff.lines
          .filter((line) => line.kind !== 'meta')
          .map((line, index) => (
            <span key={index} className={`dline dline--${line.kind}`}>
              {line.text || ' '}
            </span>
          ))}
      </pre>
    </div>
  )
}

/** The unified diff a file change carries, when its text is one. */
function fileChangeDiff(item: Item): ReturnType<typeof parseDiff> | undefined {
  const text = item.text ?? ''
  if (!/^(diff --git|--- |@@ )/m.test(text)) return undefined
  const diff = parseDiff(text)
  return diff.lines.some((line) => line.kind === 'add' || line.kind === 'del') ? diff : undefined
}

function ItemChangeStats({ item }: { item: Item }) {
  const added = item.linesAdded ?? 0
  const removed = item.linesRemoved ?? 0
  if (added === 0 && removed === 0) return null
  return <ChangeStats added={added} removed={removed} className="aux__stat" />
}

/**
 * A tool's name is an identifier, so it renders as code inside an otherwise
 * plain label. The label text stays a single string for accessible names.
 */
function activityLabelParts(item: Item, label: string): ReactNode {
  if (item.type !== 'tool_call') return label
  const { name } = parseToolCall(item.text)
  if (!name || !looksLikeIdentifier(name)) return label
  const index = label.indexOf(name)
  if (index === -1) return label
  return (
    <>
      {label.slice(0, index)}
      <code className="activity__tool">{name}</code>
      {label.slice(index + name.length)}
    </>
  )
}

/** `cua_repl.js`, `github.search_issues`, `WebFetch` — not "Searched thoughtLabel". */
function looksLikeIdentifier(name: string): boolean {
  return !/\s/.test(name) && /[._\-A-Z0-9]/.test(name)
}

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
        ref={disclosure.revealRef}
        className="aux__reveal"
        data-open={disclosure.dataOpen}
        aria-hidden={!disclosure.expanded}
        inert={!disclosure.expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'transform')
            disclosure.finishTransition()
        }}
      >
        <div className="aux__reveal-clip">
          {disclosure.contentMounted ? (
            <div className={`reasoning-summary${live ? ' is-live' : ''}`}>
              <Markdown
                text={text}
                projectPath={projectPath}
                streaming={live && item.status === 'started'}
                liveUpdate={liveTextUpdate}
                updateVersion={liveUpdateVersion}
                literalHtml
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

/**
 * Every run of tool calls between two thoughts or messages folds into one
 * batch. A lone call stays a row of its own, and a list that is nothing but
 * tool calls is already the batch its summary names. Subagents started one
 * after another gather under a header of their own and never fold into a
 * tool batch, unless they are all there is to show.
 */
function groupToolRuns(items: Item[]): (Item | Item[])[] {
  if (items.every((item) => item.subagent)) return items
  const flat = items.every(isStackedActivity)
  const rows: (Item | Item[])[] = []
  for (const item of items) {
    const previous = rows.at(-1)
    const kind = toolRunKind(item, flat)
    const previousKind =
      previous && toolRunKind(Array.isArray(previous) ? previous[0]! : previous, flat)
    if (kind && kind === previousKind) {
      if (Array.isArray(previous)) previous.push(item)
      else rows[rows.length - 1] = [previous!, item]
    } else {
      rows.push(item)
    }
  }
  return rows
}

function toolRunKind(item: Item, flat: boolean): 'subagents' | 'tools' | undefined {
  if (item.subagent) return 'subagents'
  return !flat && isStackedActivity(item) ? 'tools' : undefined
}

function ToolBatch({ items, live }: { items: Item[]; live: boolean }) {
  const disclosure = useDisclosure()
  const tally = toolTally(items, live)

  return (
    <div className="activity activity--batch" data-expanded={disclosure.expanded}>
      <button
        type="button"
        className="activity__summary"
        aria-expanded={disclosure.expanded}
        onClick={disclosure.toggle}
      >
        <span className="activity__glyph" aria-hidden>
          {toolBatchGlyph(items)}
        </span>
        <ToolTallyLabel tally={tally} />
        <ChevronRight className="activity__chevron" size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div
        ref={disclosure.revealRef}
        className="activity__reveal"
        data-open={disclosure.dataOpen}
        aria-hidden={!disclosure.expanded}
        inert={!disclosure.expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'transform')
            disclosure.finishTransition()
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
  const hasWorkNotes = completedActivity.some(
    (item) => item.type === 'reasoning' || (item.type === 'message' && item.role === 'assistant'),
  )
  const tally =
    live && current
      ? undefined
      : activity.complete || hasWorkNotes
        ? undefined
        : toolTally(operationalActivity, false)
  const stopped = !live && activity.stopped === true
  // Counted in the group the projection already holds, never across the transcript.
  const runningSubagents = runningSubagentCount(completedActivity)
  // While the main agent waits on subagents they are the news, whatever call it waits in.
  const waiting = live && current ? waitingSubagentsLabel(completedActivity) : undefined
  const label =
    live && current
      ? (waiting ?? liveActivityLabel(current))
      : tally
        ? toolTallyText(tally)
        : `${stopped ? 'Stopped after' : 'Worked for'} ${workedFor(activity.group.elapsedMs)}${
            runningSubagents > 0 ? ` · ${runningSubagentsText(runningSubagents)}` : ''
          }`
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
  const hasGlyph = live || Boolean(tally) || stopped

  return (
    <div
      className={`activity${live ? ' activity--live' : ''}${settling ? ' is-settling' : ''}`}
      data-expanded={disclosure.expanded}
    >
      <button
        type="button"
        className={`activity__summary${hasGlyph ? '' : ' activity__summary--bare'}`}
        ref={summaryRef}
        aria-expanded={disclosure.expanded}
        title={label}
        onClick={disclosure.toggle}
      >
        {hasGlyph ? (
          <span className="activity__glyph" aria-hidden>
            {tally ? (
              toolBatchGlyph(operationalActivity)
            ) : stopped ? (
              <Stop strokeWidth={1.8} />
            ) : waiting ? (
              <SubagentGlyph />
            ) : (
              glyph(summaryItem)
            )}
          </span>
        ) : null}
        {tally ? (
          <ToolTallyLabel tally={tally} announce />
        ) : (
          <span className="activity__label" aria-live="polite" aria-atomic="true">
            {live && current && !waiting && !current.subagent
              ? activityLabelParts(current, label)
              : label}
          </span>
        )}
        <ChevronRight className="activity__chevron" size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div
        ref={disclosure.revealRef}
        className="activity__reveal"
        data-open={disclosure.dataOpen}
        aria-hidden={!disclosure.expanded}
        inert={!disclosure.expanded}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'transform')
            disclosure.finishTransition()
        }}
      >
        {disclosure.contentMounted ? (
          <div className="activity__reveal-clip">
            <div className="activity__body">
              {(visibleActivity ? groupToolRuns(visibleActivity) : []).map((item) => {
                if (Array.isArray(item)) {
                  return item[0]!.subagent ? (
                    <SubagentGroup key={item[0]!.id} items={item} />
                  ) : (
                    <ToolBatch key={item[0]!.id} items={item} live={live} />
                  )
                }
                if (item.type === 'reasoning') {
                  return (
                    <ReasoningDisclosure
                      key={item.id}
                      item={item}
                      text={item.text ?? ''}
                      live={false}
                      projectPath={projectPath}
                      liveTextUpdate={undefined}
                      liveUpdateVersion={undefined}
                    />
                  )
                }
                if (item.type === 'message') {
                  return (
                    <div className="activity__message" key={item.id}>
                      <Markdown text={item.text ?? ''} projectPath={projectPath} literalHtml />
                    </div>
                  )
                }
                return (
                  <ActivityRow key={item.id} item={item} live={live && item.status === 'started'} />
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
    (item.type === 'reasoning' && !isBlankReasoning(item)) ||
    (item.type === 'message' && item.role === 'assistant' && Boolean(item.text?.trim()))
  )
}

function activityDetail(item: Item): string | undefined {
  if (item.type === 'tool_call' && designPhaseLabel(toolText(item))) return undefined
  if (isContextCompaction(item)) return undefined
  const image = imageViewDetail(item)
  if (image !== undefined) return image
  if (item.type === 'tool_call') return toolCallDetail(item)
  if (item.type === 'command') return commandOutput(item)
  const text = item.text?.trim()
  if (!text || text === activityItemLabel(item) || text === item.path) return undefined
  return text
}

/**
 * A command's text is its output. Rows persisted by an older adapter wrapped
 * it in the tool's result envelope (`Bash [ … ]\n{ … }`); those unwrap to the
 * text inside, and an empty envelope means there was no output.
 */
function commandOutput(item: Item): string | undefined {
  const text = item.text?.trim()
  if (!text) return undefined
  if (/^\S+\s[[{]/.test(text.split('\n', 1)[0] ?? '')) return parseToolCall(text).output
  return text
}

function toolCallHeadline(item: Item): string {
  const { name } = parseToolCall(item.text)
  return name ? humanToolHeadline(name) : 'Tool call'
}

/**
 * Tool names some agents use for reading and searching read as verbs. Any
 * other identifier stays exactly as the agent named it: `cua_repl.js` is a
 * tool, not "Cua repl.js".
 */
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
  return raw
}

/** Arguments and output as one text, for consumers that want a string. */
function toolCallDetail(item: Item): string | undefined {
  const call = parseToolCall(item.text)
  const args = toolArgumentEntries(call.args).map(([key, value]) => `${key}: ${value}`)
  const detail = [...args, call.output].filter(Boolean).join('\n')
  return detail || undefined
}

/**
 * A finished tool call in the expanded list. Adapters that already chose a
 * human label ("Searched thoughtLabel") keep it; a bare identifier gets a
 * verb and the argument it acted on, like the command rows beside it.
 */
function toolCallRowLabel(item: Item): string {
  const headline = toolCallHeadline(item)
  if (isWebSearch(item)) {
    const query = webSearchQuery(item)
    return query ? `Searched the web for “${query}”` : 'Searched the web'
  }
  if (headline === 'Tool call' || !looksLikeIdentifier(headline)) return headline
  const verb =
    item.status === 'failed' ? 'Failed' : item.status === 'started' ? 'Interrupted' : 'Used'
  const snippet = toolCallSnippet(item, headline)
  return `${verb} ${headline}${snippet ? ` · ${snippet}` : ''}`
}

/** The tool call's target, short enough to sit beside its name. */
function toolCallSnippet(item: Item, name: string): string | undefined {
  const snippet = toolArgumentSnippet(parseToolCall(item.text).args)
  if (!snippet || name.toLowerCase().includes(snippet.toLowerCase())) return undefined
  return snippet
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
  // A disclosure measures its row in the commit that opens it. A preview that
  // arrives a frame later would resize the reveal mid-wipe, so anything
  // already known renders in the first frame.
  const [preview, setPreview] = useState(() => knownViewedImagePreview(reference))
  const [previewSettled, setPreviewSettled] = useState(
    () => preview !== undefined || !canPreviewViewedImages,
  )
  const [viewerOpen, setViewerOpen] = useState(false)
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const known = knownViewedImagePreview(reference)
    setPreview(known)
    setPreviewSettled(known !== undefined || !canPreviewViewedImages)
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
    // Without a bridge nothing will ever load, so the plain reference is final.
    if (variant === 'detail' && fallbackClassName && !canPreviewViewedImages) {
      return <pre className={fallbackClassName}>{reference}</pre>
    }
    const status = previewSettled ? 'is-unavailable' : 'is-loading'
    const label = previewSettled
      ? `Preview unavailable for ${attachmentName(reference)}`
      : `Loading preview of ${attachmentName(reference)}`
    if (variant === 'detail') {
      // The image's own frame and name line, so the reveal around it keeps
      // its height when the preview settles.
      return (
        <div className={`viewed-image-preview ${status}`} role="status" aria-label={label}>
          <span className="viewed-image-preview__placeholder" aria-hidden>
            <Images />
            {previewSettled ? (
              <span className="viewed-image-preview__unavailable-copy">Preview unavailable</span>
            ) : null}
          </span>
          <span className="viewed-image-preview__name" title={reference}>
            {reference}
          </span>
        </div>
      )
    }
    return (
      <span
        className={`viewed-image-preview viewed-image-preview--message ${status}`}
        role="status"
        aria-label={label}
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
  return (
    IMAGE_ATTACHMENT_RE.test(reference) ||
    /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/.test(reference)
  )
}

function attachmentName(reference: string): string {
  if (reference.startsWith('data:image/')) return 'Attached image'
  return reference.split(/[\\/]/).filter(Boolean).at(-1) ?? reference
}

type ToolKind =
  | 'command'
  | 'edit'
  | 'read'
  | 'search'
  | 'web'
  | 'image'
  | 'generated-image'
  | 'plan'
  | 'compaction'
  | 'subagent'
  | 'tool'

function toolKind(item: Item): ToolKind {
  if (item.subagent) return 'subagent'
  switch (item.type) {
    case 'command':
      return 'command'
    case 'file_change':
      return 'edit'
    case 'plan':
      return 'plan'
    case 'tool_call': {
      const text = toolText(item)
      if (isContextCompaction(item)) return 'compaction'
      if (toolNameKey(item) === 'imagegeneration') return 'generated-image'
      if (isImageView(item) || text.includes('image')) return 'image'
      if (isWebSearch(item)) return 'web'
      if (isSearchTool(text)) return 'search'
      if (text.match(/read|open|file|list/)) return 'read'
      return 'tool'
    }
    default:
      return 'tool'
  }
}

function isFailedActivity(item: Item): boolean {
  return item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)
}

type ToolTally = {
  /** "Ran 3 commands", "read 2 files" — in the order the work happened. */
  phrases: string[]
  failed: number
  interrupted: number
}

/** What a batch of tool calls did, counted per kind of work. */
function toolTally(items: readonly Item[], live: boolean): ToolTally {
  const counts = new Map<ToolKind, number>()
  const editedFiles = new Set<string>()
  let failed = 0
  let interrupted = 0
  for (const item of items) {
    const kind = toolKind(item)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    if (kind === 'edit') {
      const files = fileChangeDiff(item)?.fileEntries
      if (files?.length) for (const file of files) editedFiles.add(file.path)
      else editedFiles.add(item.path ?? item.id)
    }
    if (isFailedActivity(item)) failed += 1
    else if (!live && item.status === 'started') interrupted += 1
  }
  const phrases = [...counts].map(([kind, count]) =>
    toolPhrase(kind, kind === 'edit' ? editedFiles.size : count),
  )
  return { phrases, failed, interrupted }
}

function toolPhrase(kind: ToolKind, count: number): string {
  const counted = (one: string, many: string) => `${count} ${count === 1 ? one : many}`
  switch (kind) {
    case 'command':
      return `Ran ${counted('command', 'commands')}`
    case 'edit':
      return `Edited ${counted('file', 'files')}`
    case 'read':
      return `Read ${counted('file', 'files')}`
    case 'search':
      return count === 1 ? 'Searched once' : `Searched ${count} times`
    case 'web':
      return count === 1 ? 'Searched the web' : `Searched the web ${count} times`
    case 'image':
      return `Viewed ${counted('image', 'images')}`
    case 'generated-image':
      return `Generated ${counted('image', 'images')}`
    case 'plan':
      return 'Updated the plan'
    case 'compaction':
      return 'Compacted context'
    case 'subagent':
      return `Ran ${counted('subagent', 'subagents')}`
    case 'tool':
      return `Used ${counted('tool', 'tools')}`
  }
}

/** "Ran 3 commands, read 2 files and edited 1 file". */
function toolTallySummary(tally: ToolTally): string {
  const phrases = tally.phrases.map((phrase, index) =>
    index === 0 ? phrase : `${phrase[0]?.toLowerCase()}${phrase.slice(1)}`,
  )
  const last = phrases.pop()
  if (last === undefined) return 'Used tools'
  return phrases.length === 0 ? last : `${phrases.join(', ')} and ${last}`
}

function toolTallyOutcomes(tally: ToolTally): string[] {
  return [
    ...(tally.failed > 0 ? [`${tally.failed} failed`] : []),
    ...(tally.interrupted > 0 ? [`${tally.interrupted} interrupted`] : []),
  ]
}

function toolTallyText(tally: ToolTally): string {
  return [toolTallySummary(tally), ...toolTallyOutcomes(tally)].join(' · ')
}

function ToolTallyLabel({ tally, announce }: { tally: ToolTally; announce?: boolean }) {
  const outcomes = toolTallyOutcomes(tally)
  return (
    <span
      className="activity__label"
      title={toolTallyText(tally)}
      aria-live={announce ? 'polite' : undefined}
      aria-atomic={announce ? true : undefined}
    >
      {toolTallySummary(tally)}
      {outcomes.map((outcome) => (
        <span
          key={outcome}
          className={`activity__outcome${outcome.endsWith('failed') ? ' is-failed' : ''}`}
        >
          {` · ${outcome}`}
        </span>
      ))}
    </span>
  )
}

/** One kind of work keeps its own icon; a mix reads as a stack. */
function toolBatchGlyph(items: readonly Item[]) {
  const first = items[0]
  if (!first) return <Layers size={14} />
  const kind = toolKind(first)
  return items.every((item) => toolKind(item) === kind) ? glyph(first) : <Layers size={14} />
}

function liveActivityLabel(item: Item): string {
  const ongoing = item.status === 'started'

  switch (item.type) {
    case 'command': {
      const command = commandLabel(item.command)
      if (item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)) {
        return command ? `Command failed: ${command}` : 'Command failed'
      }
      if (!command) return ongoing ? 'Running a command' : 'Ran a command'
      return `${ongoing ? 'Running' : 'Ran'} ${command}`
    }
    case 'file_change': {
      const target = fileChangeTarget(item)
      if (item.status === 'failed')
        return target ? `Could not edit ${target}` : 'Could not edit files'
      if (!target) return ongoing ? 'Editing files' : 'Edited files'
      return `${ongoing ? 'Editing' : 'Edited'} ${target}`
    }
    case 'tool_call': {
      if (item.subagent) return subagentActivityLabel(item.subagent)
      const text = toolText(item)
      if (isImageView(item)) {
        if (item.status === 'failed') return 'Could not view image'
        return ongoing ? 'Viewing image' : 'Viewed image'
      }
      if (text.includes('image')) return ongoing ? 'Viewing images' : 'Viewed images'
      if (isWebSearch(item)) {
        const query = webSearchQuery(item)
        const verb = ongoing ? 'Searching' : 'Searched'
        return query ? `${verb} the web for “${query}”` : `${verb} the web`
      }
      if (isSearchTool(text)) return ongoing ? 'Searching' : 'Searched'
      if (text.match(/read|open|file|list/)) return ongoing ? 'Reading files' : 'Read files'
      const tool = inlineActivityText(toolCallHeadline(item))
      if (!tool || tool === 'Tool call') return ongoing ? 'Using a tool' : 'Used a tool'
      const verb = item.status === 'failed' ? 'Failed' : ongoing ? 'Using' : 'Used'
      // The argument the tool acts on keeps consecutive calls of the same
      // tool from reading as one stuck row.
      const snippet = toolCallSnippet(item, tool)
      return `${verb} ${tool}${snippet ? ` · ${snippet}` : ''}`
    }
    case 'plan':
      return ongoing ? 'Updating the plan' : 'Updated the plan'
    default:
      return summariseLive(item)
  }
}

function activityItemLabel(item: Item): string {
  if (item.type === 'command') {
    const command = commandLabel(item.command)
    if (item.status === 'started')
      return command ? `Command interrupted: ${command}` : 'Command interrupted'
    if (item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)) {
      return command ? `Command failed: ${command}` : 'Command failed'
    }
    return command ? `Ran ${command}` : 'Ran a command'
  }

  if (item.type === 'file_change') {
    const target = fileChangeTarget(item)
    if (item.status === 'started')
      return target ? `Edit interrupted: ${target}` : 'Edit interrupted'
    if (item.status === 'failed')
      return target ? `Could not edit ${target}` : 'Could not edit files'
    return target ? `Edited ${target}` : 'Edited files'
  }

  if (item.type === 'plan') return 'Updated plan'

  return summarise(item)
}

/** One path reads as the path; a patch across several files reads as a count. */
function fileChangeTarget(item: Item): string {
  const files = fileChangeDiff(item)?.fileEntries.length ?? 0
  if (files > 1) return `${files} files`
  return inlineActivityText(item.path)
}

function isWebSearch(item: Item): boolean {
  return item.type === 'tool_call' && /^web ?search$/i.test(parseToolCall(item.text).name)
}

function webSearchQuery(item: Item): string | undefined {
  const { args } = parseToolCall(item.text)
  const query = args && !Array.isArray(args) ? args['query'] : undefined
  return typeof query === 'string' && query.trim() ? inlineActivityText(query) : undefined
}

/**
 * Codex runs every command through a login shell, so the label would start
 * with the same `/bin/zsh -lc` on every row. The command inside is what ran.
 */
function commandLabel(command: string | undefined): string {
  const text = inlineActivityText(command)
  const wrapped = /^(?:\S*[\\/])?(?:ba|z)?sh(?:\.exe)? -l?c (['"])([\s\S]*)\1$/.exec(text)
  const inner = wrapped?.[2]?.trim() || text
  // Claude Code starts many commands with `cd "<absolute project path>" &&`.
  // In a one-line row that path used up the width and the part that does the
  // work was cut off, so the label starts at the command after it. A relative
  // cd says where in the project the command runs, so it stays.
  return inner.replace(LEADING_ABSOLUTE_CD, '') || inner
}

const LEADING_ABSOLUTE_CD =
  /^cd(?:\s+\/d)?\s+(?:"(?:[a-z]:|[\\/~])[^"]*"|'(?:[a-z]:|[\\/~])[^']*'|(?:[a-z]:|[\\/~])[^\s;&|]*)\s*(?:&&|;)\s*/i

function inlineActivityText(text: string | undefined): string {
  return text?.replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * One formatter for every reply's time. toLocaleTimeString builds a new
 * formatter on each call, and every reply row that mounts while a long chat
 * is paged calls it.
 */
const RESPONSE_TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

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
      <CopyButton text={text} label="Copy response" />
      {checkpoint && onRevertCheckpoint ? (
        <button
          type="button"
          onClick={() => onRevertCheckpoint(checkpoint)}
          aria-label="Restore to before this turn"
          title="Restore to before this turn"
        >
          <History aria-hidden />
        </button>
      ) : null}
      <time dateTime={new Date(createdAt).toISOString()}>{RESPONSE_TIME.format(createdAt)}</time>
    </div>
  )
}

// Memoized: the working rail renders it on every transcript render.
const TurnDuration = memo(function TurnDuration(
  props: { startedAt: number } | { elapsedMs: number; stopped?: boolean | undefined },
) {
  const working = 'startedAt' in props
  const stopped = !working && props.stopped === true
  return (
    <div className={`activity activity--duration${working ? ' activity--working' : ''}`}>
      <div className={`activity__summary${stopped || working ? '' : ' activity__summary--bare'}`}>
        {working ? (
          <WorkingPulse />
        ) : stopped ? (
          <span className="activity__glyph" aria-hidden>
            <Stop strokeWidth={1.8} />
          </span>
        ) : null}
        <span className="activity__label">
          {working ? (
            <>
              Working for <WorkingTimer startedAt={props.startedAt} />
            </>
          ) : (
            `${stopped ? 'Stopped after' : 'Worked for'} ${workedFor(props.elapsedMs)}`
          )}
        </span>
      </div>
    </div>
  )
})

/**
 * The one sign that a turn is still working, the same for every turn: a dot
 * that breathes on the compositor (transform and opacity only), so it costs
 * the main thread nothing per frame while a reply streams beside it.
 */
function WorkingPulse() {
  return (
    <span className="activity__glyph" aria-hidden>
      <span className="activity__pulse" />
    </span>
  )
}

/** The quiet end of a turn the user stopped, under whatever it reached. */
function TurnStopped() {
  return (
    <p className="turn-stopped">
      <span className="turn-stopped__dot" aria-hidden />
      Stopped by you
    </p>
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
        <WorkingPulse />
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
  if (item.subagent) return <SubagentGlyph />

  switch (item.type) {
    case 'message':
      return <Brain size={13} />
    case 'command':
      return <SquareTerminal size={13} />
    case 'reasoning':
      return <Brain size={13} />
    case 'file_change':
      return <FilePenLine size={13} />
    case 'tool_call': {
      const name = toolText(item)
      if (name.includes('image')) return <Images size={14} />
      if (designPhaseLabel(name)) return <Palette size={13} />
      if (isWebSearch(item)) return <WorldSearch size={14} />
      if (isSearchTool(name)) return <Search size={14} />
      if (name.match(/read|open|file|list/)) return <BookOpen size={14} />
      return <Wrench size={13} />
    }
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
      if (item.subagent) return subagentActivityLabel(item.subagent)
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

/**
 * What a tool is, for the read/search/image heuristics: its name and the
 * command line, never its arguments or output — a screenshot script that
 * mentions "file" is not a file read.
 */
function toolText(item: Item): string {
  return `${parseToolCall(item.text).name} ${item.command ?? ''}`.toLowerCase()
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
            : toolCallRowLabel(item))
      )
    case 'plan':
      return 'Plan'
    case 'unknown':
      return unknownActivityLabel(item)
    default:
      return 'Activity'
  }
}

/** The tool's name on the first line, lowercased with punctuation removed. */
function toolNameKey(item: Item): string | undefined {
  return (item.text ?? '')
    .split('\n', 1)[0]
    ?.replaceAll(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function supportedActivitySummary(item: Item, ongoing: boolean): string | undefined {
  if (item.type !== 'tool_call' && item.type !== 'unknown') return undefined
  const name = toolNameKey(item)
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
