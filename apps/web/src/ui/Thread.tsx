import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalReview,
  Item,
  PlanStep,
  UserInputRequest,
} from '@harness/contracts'
import { ThinkingOrb } from 'thinking-orbs'
import {
  ArrowDownToLine,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  CircleQuestionMark,
  Copy,
  FilePenLine,
  Images,
  ListChecks,
  LoaderCircle,
  Palette,
  Pencil,
  RotateCcw,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { writeClipboardText } from '../bridge.js'
import { isEditableTarget } from '../shortcuts.js'
import type { Transport } from '../transport.js'
import { Approval, AutomaticApprovalReview } from './Approval.js'
import { Diff } from './Diff.js'
import { Markdown } from './Markdown.js'
import { Plan } from './Plan.js'
import { ThreadSearch } from './ThreadSearch.js'
import { createThreadProjector, neighbourTurn, type TurnTiming } from './turns.js'
import { isAtBottom, modeForNewTurn, shouldReleaseAnchor, type ScrollMode } from './scroll-mode.js'
import { useVirtualItemKey } from './use-virtual-item-key.js'
import { UserInput } from '../design-agent/UserInput.js'
import type { Checkpoint } from './RollbackDialog.js'

/**
 * The thread.
 *
 * Virtualised: only the rows near the viewport exist in the DOM, so a session
 * with hundreds of turns costs the same as one with five. Rows are measured
 * rather than estimated because a single item can be three words or a 400-line
 * diff, and a wrong estimate shows up as scroll drift.
 *
 * Messages read as prose; commands, reasoning and file edits collapse to one
 * line you can open. The default view should read as a summary of what
 * happened, not a transcript of every byte.
 */
export function Thread(props: {
  items: Item[]
  running: boolean
  searching?: boolean
  activeTurn: { id: string; startedAt: number } | undefined
  turnTiming?: TurnTiming | undefined
  plan: PlanStep[]
  diff: string | undefined
  threadId?: string | undefined
  transport?: Transport | undefined
  searchJump?: { turnId: string; request: number } | undefined
  revealRequest?: number | undefined
  approvals: ApprovalRequest[]
  userInputs: UserInputRequest[]
  reviews: ApprovalReview[]
  checkpoints?: Checkpoint[] | undefined
  onEditMessage?: ((text: string) => void) | undefined
  onRevertCheckpoint?: ((checkpoint: Checkpoint) => void) | undefined
  onDecide: (id: string, decision: ApprovalDecision) => void
  onAnswerUserInput: (id: string, answers: Record<string, string[]>) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ScrollMode>('follow-end')
  const [finding, setFinding] = useState(false)
  const completedSearchJump = useRef(0)
  const completedRevealRequest = useRef(props.revealRequest ?? 0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** Index the current turn starts at, for anchor mode. */
  const anchorIndex = useRef(0)
  const wasRunning = useRef(props.running)
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
  const enteringItemIds = useEnteringItemIds(props.items, props.threadId)
  const settledTurnId = useSettledTurnId(props.running, props.activeTurn?.id)
  const getItemKey = useVirtualItemKey(props.items, props.threadId, props.revealRequest ?? 0)

  const virtualizer = useVirtualizer({
    count: props.items.length,
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
  useEffect(() => {
    if (props.running && !wasRunning.current) {
      const el = scroller.current
      anchorIndex.current = Math.max(0, props.items.length - 1)
      setMode(modeForNewTurn(el ? isAtBottom(el) : true))
    }
    wasRunning.current = props.running
  }, [props.running, props.items.length])

  // Layout effect, not effect: this runs before paint, so the correction is
  // never visible as a jump.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return

    const revealRequest = props.revealRequest ?? 0
    if (completedRevealRequest.current !== revealRequest) {
      completedRevealRequest.current = revealRequest
      modeRef.current = 'follow-end'
      setMode('follow-end')
      writeScrollTop(el, el.scrollHeight - el.clientHeight)
      return
    }

    if (modeRef.current === 'follow-end') {
      writeScrollTop(el, el.scrollHeight - el.clientHeight)
      return
    }

    if (modeRef.current === 'anchor-turn') {
      const start = virtualizer.getOffsetForIndex(anchorIndex.current, 'start')?.[0]
      if (start === undefined) return
      const turnHeight = virtualizer.getTotalSize() - start
      if (shouldReleaseAnchor(turnHeight, el.clientHeight)) {
        setMode('follow-end')
        return
      }
      writeScrollTop(el, start)
    }
  }, [props.items, props.revealRequest, virtualizer, writeScrollTop])

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
    // Any manual scroll hands control back to the user — from anchor mode
    // too, not only from follow-end.
    if (isAtBottom(el)) {
      if (modeRef.current !== 'follow-end') setMode('follow-end')
    } else if (modeRef.current !== 'free') {
      setMode('free')
    }
  }, [])

  // Ctrl+F cannot work with a virtualised list — the match may not be in the
  // DOM — so the app owns find instead of the browser.
  useEffect(() => {
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
  }, [])

  const jumpTo = useCallback(
    (index: number) => {
      setMode('free')
      virtualizer.scrollToIndex(index, { align: 'center' })
    },
    [virtualizer],
  )

  const projectThread = useMemo(createThreadProjector, [props.threadId])
  const { turns, presentations } = projectThread(props.items, props.turnTiming)
  const activePresentation = props.activeTurn ? presentations.get(props.activeTurn.id) : undefined
  const rawWorkLabel = useMemo(
    () => workLabel(props.items, props.activeTurn?.id, props.searching),
    [props.items, props.activeTurn?.id, props.searching],
  )
  // Between two tool calls — which is exactly while prose streams — nothing
  // is 'started', so the label fell back to the generic "Working" and then
  // returned. Each flip remounts the span and replays its fade, so a normal
  // read/search/edit sequence strobed. Hold the last specific label instead.
  const lastSpecific = useRef<string | undefined>(undefined)
  const activeTurnId = props.activeTurn?.id
  const previousTurnId = useRef(activeTurnId)
  if (previousTurnId.current !== activeTurnId) {
    previousTurnId.current = activeTurnId
    lastSpecific.current = undefined
  }
  if (rawWorkLabel !== 'Working') lastSpecific.current = rawWorkLabel
  const activeWorkLabel =
    rawWorkLabel === 'Working' ? (lastSpecific.current ?? 'Working') : rawWorkLabel

  useEffect(() => {
    const target = props.searchJump
    if (!target || completedSearchJump.current === target.request) return
    const index = props.items.findIndex((item) => item.turnId === target.turnId)
    if (index < 0) return
    completedSearchJump.current = target.request
    setFinding(false)
    setMode('free')
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [props.items, props.searchJump, virtualizer])

  // Alt+Up/Down moves a turn at a time. Scrolling by pixel through a long
  // session to find where an exchange began is the slow way to do it.
  useEffect(() => {
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
  }, [turns, virtualizer])

  const rows = virtualizer.getVirtualItems()

  // The working rail mounts in exactly one place — inside the runway, after
  // the rows — for the whole turn. Rendering it inside the row at
  // firstResponseIndex remounted it at the first token (a different tree
  // position is an unmount) and again whenever that row left the overscan
  // window, restarting the orb and its entrance animation mid-turn. Instead
  // the rail is translated to sit above the first response row, whose
  // .is-rail-anchor padding reserves the space it overlays.
  //
  // measurementsCache, not getOffsetForIndex: the latter clamps to the
  // maximum scroll offset, which is below the anchor row's true start
  // whenever the thread is shorter than the viewport.
  const railIndex =
    props.running && props.activeTurn ? activePresentation?.firstResponseIndex : undefined
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
      {finding ? (
        <ThreadSearch items={props.items} onJump={jumpTo} onClose={() => setFinding(false)} />
      ) : null}
      <div className="thread" ref={scroller} onScroll={onScroll}>
        <div className="thread__col">
          <div className="thread__runway" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const item = props.items[row.index]
              if (!item) return null
              const presentation = presentations.get(item.turnId)
              const live = props.running && props.activeTurn?.id === item.turnId
              const compactedActivity =
                !live && presentation?.complete === true && presentation.activity.includes(item)
              const activityLead =
                compactedActivity && presentation.firstActivityIndex === row.index
              const responseLead =
                !live &&
                presentation?.complete === true &&
                presentation.finalAnswerIndex === row.index
              const suppressed =
                (compactedActivity && !activityLead) ||
                isRepeatedDesignRow(item, props.items[row.index - 1]) ||
                // A design turn tells its story through the phase labels and
                // Harness notes; the provider's raw commands, tool calls, and
                // thinking would drown that story in noise.
                (presentation?.design === true &&
                  isActivity(item) &&
                  !designPhaseLabel(toolText(item)))
              const liveActivity = live && isActivity(item)
              const settling = settledTurnId === item.turnId
              const railAnchor = live && presentation?.firstResponseIndex === row.index
              return (
                <div
                  key={row.key}
                  className={`thread__row${suppressed ? ' is-suppressed' : ''}${liveActivity ? ' is-live-activity' : ''}${enteringItemIds.has(item.id) ? ' is-entering' : ''}${settling ? ' is-settling' : ''}${railAnchor ? ' is-rail-anchor' : ''}`}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <Row
                    item={item}
                    hidden={suppressed}
                    activity={activityLead ? presentation.activity : undefined}
                    elapsedMs={presentation?.elapsedMs}
                    live={live}
                    responseText={responseLead ? presentation.responseText : undefined}
                    settling={settling}
                    showCompletionRail={
                      !live &&
                      presentation?.complete === true &&
                      presentation.activity.length === 0 &&
                      presentation.finalAnswerIndex === row.index
                    }
                    onEditMessage={props.onEditMessage}
                    checkpoint={checkpointFor(item, props.checkpoints ?? [])}
                    onRevertCheckpoint={props.onRevertCheckpoint}
                  />
                </div>
              )
            })}
            {props.running && props.activeTurn ? (
              // Deliberately not keyed by turn id: the optimistic turn's id is
              // replaced by the server's a few seconds in, and a key would
              // remount the rail at exactly the moment this render position
              // exists to survive. Before any response row exists the rail
              // sits at the end of the runway, over the space the spacer
              // below holds.
              <div className="thread__rail" style={{ transform: `translateY(${railOffset}px)` }}>
                <WorkingRail startedAt={props.activeTurn.startedAt} label={activeWorkLabel} />
              </div>
            ) : null}
          </div>

          {props.running && props.activeTurn && railIndex === undefined ? (
            <div className="thread__rail-spacer" aria-hidden />
          ) : null}

          {/* Above the plan and the diff: it is the only thing here that blocks
            the agent, so it should be the first thing the eye lands on. */}
          {props.userInputs.map((request) => (
            <UserInput
              key={request.id}
              request={request}
              onSubmit={(answers) => props.onAnswerUserInput(request.id, answers)}
            />
          ))}

          {props.approvals.map((request) => (
            <Approval
              key={request.id}
              request={request}
              onDecide={(d) => props.onDecide(request.id, d)}
            />
          ))}

          {props.reviews.map((review) => (
            <AutomaticApprovalReview key={review.id} review={review} />
          ))}

          {props.running ? <Plan steps={props.plan} compact /> : null}
          {!props.running ? (
            <Diff diff={props.diff} threadId={props.threadId} transport={props.transport} />
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
}

const ITEM_ENTRY_MS = 360
const TURN_SETTLE_MS = 520

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
    let incoming: Item[] = []

    if (items.length > previous.length) {
      const appended = items.slice(previous.length)
      // Loading an existing transcript is one state replacement, not a burst
      // of new messages. A live event appends one item at a time.
      if (!(previous.length === 0 && appended.length > 1)) incoming = appended
    } else if (items.length === previous.length && items.length > 0) {
      const previousTail = previous.at(-1)
      const nextTail = items.at(-1)
      const prefixStayedStable = items.length === 1 || previous.at(-2)?.id === items.at(-2)?.id
      const reconciledLocalEcho =
        previousTail?.id.startsWith('local:') === true &&
        previousTail.role === 'user' &&
        nextTail?.role === 'user' &&
        previousTail.text === nextTail.text

      if (
        prefixStayedStable &&
        nextTail &&
        previousTail?.id !== nextTail.id &&
        !reconciledLocalEcho
      ) {
        incoming = [nextTail]
      }
    }

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

function isAssistantMessage(item: Item): boolean {
  return item.type === 'message' && item.role === 'assistant'
}

const Row = memo(function Row({
  item,
  hidden,
  activity,
  elapsedMs,
  live,
  responseText,
  settling,
  showCompletionRail,
  onEditMessage,
  checkpoint,
  onRevertCheckpoint,
}: {
  item: Item
  hidden: boolean
  activity: Item[] | undefined
  elapsedMs: number | undefined
  live: boolean
  responseText: string | undefined
  settling: boolean
  showCompletionRail: boolean
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
    return <CompletionRail activity={activity} elapsedMs={elapsedMs ?? 0} settling={settling} />
  }

  // The user's own words get a surface so the eye can find where each exchange
  // begins; the agent's answer is plain prose, which is what you actually read.
  if (item.type === 'message' && item.role === 'user') {
    return (
      <div className="said">
        <p className="said__text">{item.text}</p>
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
        {showCompletionRail ? (
          <CompletionRail activity={[]} elapsedMs={elapsedMs ?? 0} settling={settling} />
        ) : null}
        <Markdown text={text} streaming={live && item.status === 'started'} />
        {!live && item.status === 'completed' && text ? (
          <ResponseActions text={text} createdAt={item.createdAt} />
        ) : null}
      </div>
    )
  }

  return <AuxDisclosure item={item} live={live} />
})

/**
 * One collapsed operational row — a command, reasoning, file edit or tool
 * call. A controlled disclosure rather than <details>: keeping the output
 * mounted lets the height transition play both ways, so closing is as smooth
 * as opening, exactly like the completion rail below.
 */
function AuxDisclosure({ item, live }: { item: Item; live: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`aux aux--${item.type} ${live ? 'aux--live' : ''}`} data-expanded={expanded}>
      <button
        type="button"
        className="aux__row"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="aux__glyph" aria-hidden>
          {glyph(item)}
        </span>
        <span className="aux__label">{live ? summariseLive(item) : summarise(item)}</span>
        {item.exitCode !== undefined && item.exitCode !== 0 ? (
          <span className="aux__code">exit {item.exitCode}</span>
        ) : null}
        {/* Only worth showing once it is long enough to have been noticed. */}
        {item.durationMs !== undefined && item.durationMs >= 1000 ? (
          <span className="aux__time">{duration(item.durationMs)}</span>
        ) : null}
        {!live && item.status === 'started' ? (
          <LoaderCircle className="spinner" aria-hidden />
        ) : null}
      </button>
      {/* Design markers have no output worth expanding — their text is the slug. */}
      {item.text && !(item.type === 'tool_call' && designPhaseLabel(toolText(item))) ? (
        <div className="aux__reveal" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
          <div className="aux__reveal-clip">
            <pre className="aux__out">{item.text}</pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function checkpointFor(item: Item, checkpoints: Checkpoint[]): Checkpoint | undefined {
  if (item.type !== 'message' || item.role !== 'user' || !item.text) return undefined
  const label = item.text.trim().slice(0, 60) || 'Turn'
  return checkpoints.findLast(
    (checkpoint) => checkpoint.label === label && checkpoint.createdAt <= item.createdAt,
  )
}

function CompletionRail({
  activity,
  elapsedMs,
  settling,
}: {
  activity: Item[]
  elapsedMs: number
  settling: boolean
}) {
  const label = `Worked for ${workedFor(elapsedMs)}`
  const visibleActivity = activity.filter(isVisibleWorkedItem)
  const [expanded, setExpanded] = useState(false)

  if (visibleActivity.length === 0) {
    return (
      <div className={`activity activity--empty${settling ? ' is-settling' : ''}`}>
        <div className="activity__summary">{label}</div>
      </div>
    )
  }

  return (
    <div className={`activity${settling ? ' is-settling' : ''}`} data-expanded={expanded}>
      <button
        type="button"
        className="activity__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>{label}</span>
        <ChevronRight size={15} strokeWidth={1.8} aria-hidden />
      </button>
      <div
        className="activity__reveal"
        data-open={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="activity__reveal-clip">
          <div className="activity__body">
            {visibleActivity.map((item) =>
              item.type === 'message' ? (
                <div className="activity__message" key={item.id}>
                  <Markdown text={item.text ?? ''} />
                </div>
              ) : (
                <div className="activity__file-change" key={item.id}>
                  <FilePenLine size={15} strokeWidth={1.8} aria-hidden />
                  <span>Edited files</span>
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function isVisibleWorkedItem(item: Item): boolean {
  return (
    item.type === 'file_change' ||
    (isAssistantMessage(item) && item.status === 'completed' && Boolean(item.text?.trim()))
  )
}

function ResponseActions({ text, createdAt }: { text: string; createdAt: number }) {
  return (
    <div className="response-actions" aria-label="Response actions">
      <CopyAction text={text} label="Copy response" />
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
        {failed ? (
          <CircleAlert aria-hidden />
        ) : copied ? (
          <Check aria-hidden />
        ) : (
          <Copy aria-hidden />
        )}
      </button>
      {failed ? (
        <span className="copy-action__error" role="alert">
          Copy failed
        </span>
      ) : null}
    </span>
  )
}

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
        <span className="activity__working-label" key={label}>
          {label}
        </span>
        <span className="activity__working-time">
          <WorkingTimer startedAt={startedAt} />
        </span>
      </div>
    </div>
  )
})

export function workLabel(
  items: Item[],
  turnId: string | undefined,
  searching: boolean | undefined,
) {
  if (searching) return 'Searching'
  if (!turnId) return 'Working'

  // The active turn's items are the tail of the transcript; once the walk
  // leaves them there is nothing further back worth scanning — without the
  // break this was a full-transcript scan per streamed frame.
  let latest: string | undefined
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (!item) continue
    if (item.turnId !== turnId) break
    if (item.status !== 'started' || !isActivity(item)) continue
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
    const update = () => {
      if (text.current) text.current.textContent = workedFor(Math.max(0, Date.now() - startedAt))
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
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
  switch (item.type) {
    case 'command':
      return <SquareTerminal size={13} />
    case 'reasoning':
      return <Brain size={13} />
    case 'file_change':
      return <FilePenLine size={13} />
    case 'tool_call':
      if (toolText(item).includes('image')) return <Images size={14} />
      if (designPhaseLabel(toolText(item))) return <Palette size={13} />
      if (toolText(item).match(/read|open|file/)) return <BookOpen size={14} />
      if (toolText(item).includes('search')) return <Search size={14} />
      return <Wrench size={13} />
    case 'plan':
      return <ListChecks size={13} />
    case 'error':
      return <CircleAlert size={13} />
    default:
      return <CircleQuestionMark size={13} />
  }
}

function summariseLive(item: Item): string {
  const ongoing = item.status === 'started'

  switch (item.type) {
    case 'command':
      return ongoing ? 'Running a command' : 'Ran a command'
    case 'reasoning':
      return 'Thinking'
    case 'file_change':
      return ongoing ? 'Editing files' : 'Edited files'
    case 'tool_call': {
      const text = toolText(item)
      const designPhase = designPhaseLabel(text)
      if (designPhase) return designPhase
      if (text.includes('image')) return ongoing ? 'Viewing an image' : 'Viewed an image'
      if (text.match(/read|open|file/)) return ongoing ? 'Reading files' : 'Read files'
      if (text.includes('search')) return ongoing ? 'Searching' : 'Searched'
      return ongoing ? 'Using a tool' : 'Used a tool'
    }
    case 'plan':
      return ongoing ? 'Updating the plan' : 'Updated the plan'
    default:
      return summarise(item)
  }
}

function designPhaseLabel(text: string): string | undefined {
  if (text.includes('design:brief')) return 'Preparing questions'
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
  switch (item.type) {
    case 'command':
      return item.command ?? 'command'
    case 'reasoning':
      return 'Thinking'
    case 'file_change':
      return 'Edited files'
    case 'tool_call':
      // Design phase markers carry an internal slug; the reader gets the
      // same human label the working rail used while the phase ran.
      return designPhaseLabel(toolText(item)) ?? item.text ?? 'Tool call'
    case 'plan':
      return 'Plan'
    case 'error':
      return item.text ?? 'Error'
    default:
      return item.type
  }
}

/** A phase that retried produces one marker per provider turn; the reader
 *  cares that the phase happened, not how many turns it took. */
export function isRepeatedDesignRow(item: Item, prior: Item | undefined): boolean {
  if (!prior) return false
  if (item.type !== 'tool_call' || prior.type !== 'tool_call') return false
  const phase = designPhaseLabel(toolText(item))
  return phase !== undefined && phase === designPhaseLabel(toolText(prior))
}
