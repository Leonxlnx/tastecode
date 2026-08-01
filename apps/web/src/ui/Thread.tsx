import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalReview,
  Item,
  PlanStep,
} from '@harness/contracts'
import {
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
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { isEditableTarget } from '../shortcuts.js'
import { Approval, AutomaticApprovalReview } from './Approval.js'
import { Diff } from './Diff.js'
import { Markdown } from './Markdown.js'
import { Plan } from './Plan.js'
import { ThreadSearch } from './ThreadSearch.js'
import { findTurns, neighbourTurn, presentTurns } from './turns.js'
import { isAtBottom, modeForNewTurn, shouldReleaseAnchor, type ScrollMode } from './scroll-mode.js'

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
  activeTurn: { id: string; startedAt: number } | undefined
  plan: PlanStep[]
  diff: string | undefined
  approvals: ApprovalRequest[]
  reviews: ApprovalReview[]
  onDecide: (id: string, decision: ApprovalDecision) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ScrollMode>('follow-end')
  const [finding, setFinding] = useState(false)
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** Index the current turn starts at, for anchor mode. */
  const anchorIndex = useRef(0)
  const wasRunning = useRef(props.running)
  const enteringItemIds = useEnteringItemIds(props.items)
  const settledTurnId = useSettledTurnId(props.running, props.activeTurn?.id)

  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => scroller.current,
    // Roughly one paragraph. Wrong estimates only cost a correction on measure.
    estimateSize: () => 72,
    // Stable identity per item, never the index — index keys make every
    // insertion look like a change to every row after it.
    getItemKey: (index) => props.items[index]?.id ?? index,
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

    if (modeRef.current === 'follow-end') {
      el.scrollTop = el.scrollHeight
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
      el.scrollTop = start
    }
  }, [props.items, virtualizer])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    // Any manual scroll hands control back to the user. Fighting them for the
    // viewport is the single most hostile thing a chat UI can do.
    if (isAtBottom(el)) {
      if (modeRef.current === 'free') setMode('follow-end')
    } else if (modeRef.current === 'follow-end') {
      setMode('free')
    }
  }, [])

  // Ctrl+F cannot work with a virtualised list — the match may not be in the
  // DOM — so the app owns find instead of the browser.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
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

  const turns = useMemo(() => findTurns(props.items), [props.items])
  const presentations = useMemo(() => presentTurns(props.items), [props.items])
  const activePresentation = props.activeTurn ? presentations.get(props.activeTurn.id) : undefined

  // Alt+Up/Down moves a turn at a time. Scrolling by pixel through a long
  // session to find where an exchange began is the slow way to do it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      const rows = virtualizer.getVirtualItems()
      const current = rows[0]?.index ?? 0
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

  return (
    <div className="thread" ref={scroller} onScroll={onScroll}>
      {finding ? (
        <ThreadSearch items={props.items} onJump={jumpTo} onClose={() => setFinding(false)} />
      ) : null}
      <div className="thread__col">
        <div className="thread__runway" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const item = props.items[row.index]
            if (!item) return null
            const presentation = presentations.get(item.turnId)
            const live = props.running && props.activeTurn?.id === item.turnId
            const compactedActivity =
              !live && presentation?.complete === true && presentation.activity.includes(item)
            const activityLead = compactedActivity && presentation.firstActivityIndex === row.index
            const responseLead =
              !live &&
              presentation?.complete === true &&
              presentation.finalAnswerIndex === row.index
            const suppressed = compactedActivity && !activityLead
            const liveActivity = live && isActivity(item)
            const settling = settledTurnId === item.turnId
            return (
              <div
                key={row.key}
                className={`thread__row${suppressed ? ' is-suppressed' : ''}${liveActivity ? ' is-live-activity' : ''}${enteringItemIds.has(item.id) ? ' is-entering' : ''}${settling ? ' is-settling' : ''}`}
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
                  showWorkingRail={live && presentation?.firstResponseIndex === row.index}
                  startedAt={props.activeTurn?.startedAt}
                  showCompletionRail={
                    !live &&
                    presentation?.complete === true &&
                    presentation.activity.length === 0 &&
                    presentation.finalAnswerIndex === row.index
                  }
                />
              </div>
            )
          })}
        </div>

        {props.running &&
        props.activeTurn &&
        activePresentation?.firstResponseIndex === undefined ? (
          <WorkingRail startedAt={props.activeTurn.startedAt} />
        ) : null}

        {/* Above the plan and the diff: it is the only thing here that blocks
            the agent, so it should be the first thing the eye lands on. */}
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
        {!props.running ? <Diff diff={props.diff} /> : null}
      </div>

      {mode === 'free' ? (
        <button
          className="jump"
          onClick={() => {
            setMode('follow-end')
            const el = scroller.current
            if (el) el.scrollTop = el.scrollHeight
          }}
        >
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
function useEnteringItemIds(items: Item[]): ReadonlySet<string> {
  const previousItems = useRef(items)
  const timers = useRef(new Map<string, number>())
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set())

  useLayoutEffect(() => {
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
        previousTail?.id.startsWith('optimistic:') === true &&
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

function Row({
  item,
  hidden,
  activity,
  elapsedMs,
  live,
  responseText,
  settling,
  showWorkingRail,
  startedAt,
  showCompletionRail,
}: {
  item: Item
  hidden: boolean
  activity: Item[] | undefined
  elapsedMs: number | undefined
  live: boolean
  responseText: string | undefined
  settling: boolean
  showWorkingRail: boolean
  startedAt: number | undefined
  showCompletionRail: boolean
}) {
  if (hidden) return null

  if (activity) {
    return <CompletionRail activity={activity} elapsedMs={elapsedMs ?? 0} settling={settling} />
  }

  // The user's own words get a surface so the eye can find where each exchange
  // begins; the agent's answer is plain prose, which is what you actually read.
  if (item.type === 'message' && item.role === 'user') {
    return (
      <div className="said">
        <p className="said__text">{item.text}</p>
      </div>
    )
  }

  if (item.type === 'message') {
    const text = responseText ?? item.text ?? ''
    return (
      <>
        {showWorkingRail && startedAt !== undefined ? <WorkingRail startedAt={startedAt} /> : null}
        <div className={`reply${live ? ' is-streaming' : ''}`}>
          {showCompletionRail ? (
            <CompletionRail activity={[]} elapsedMs={elapsedMs ?? 0} settling={settling} />
          ) : null}
          <Markdown text={text} streaming={live && item.status === 'started'} />
          {!live && item.status === 'completed' && text ? (
            <ResponseActions text={text} createdAt={item.createdAt} />
          ) : null}
        </div>
      </>
    )
  }

  return (
    <>
      {showWorkingRail && startedAt !== undefined ? <WorkingRail startedAt={startedAt} /> : null}
      <details className={`aux aux--${item.type} ${live ? 'aux--live' : ''}`}>
        <summary className="aux__row">
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
        </summary>
        {item.text ? <pre className="aux__out">{item.text}</pre> : null}
      </details>
    </>
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

  if (visibleActivity.length === 0) {
    return (
      <div className={`activity activity--empty${settling ? ' is-settling' : ''}`}>
        <div className="activity__summary">{label}</div>
      </div>
    )
  }

  return (
    <details className={`activity${settling ? ' is-settling' : ''}`}>
      <summary className="activity__summary">
        <span>{label}</span>
        <ChevronRight size={15} strokeWidth={1.8} aria-hidden />
      </summary>
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
    </details>
  )
}

function isVisibleWorkedItem(item: Item): boolean {
  return (
    item.type === 'file_change' ||
    (isAssistantMessage(item) && item.status === 'completed' && Boolean(item.text?.trim()))
  )
}

function ResponseActions({ text, createdAt }: { text: string; createdAt: number }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="response-actions" aria-label="Response actions">
      <button type="button" onClick={() => void copy()} aria-label="Copy response" title="Copy">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </button>
      <time dateTime={new Date(createdAt).toISOString()}>
        {new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </time>
    </div>
  )
}

function WorkingRail({ startedAt }: { startedAt: number }) {
  return (
    <div className="activity activity--working">
      <div className="activity__summary">
        <span className="activity__working-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span>
          Working for <WorkingTimer startedAt={startedAt} />
        </span>
      </div>
    </div>
  )
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

function workedFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
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
      return item.text ?? 'Tool call'
    case 'plan':
      return 'Plan'
    case 'error':
      return item.text ?? 'Error'
    default:
      return item.type
  }
}
