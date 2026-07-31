import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ApprovalDecision, ApprovalRequest, Item, PlanStep } from '@harness/contracts'
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
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from 'lucide-react'
import { isEditableTarget } from '../shortcuts.js'
import { Approval } from './Approval.js'
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
  onDecide: (id: string, decision: ApprovalDecision) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<ScrollMode>('follow-end')
  const [finding, setFinding] = useState(false)
  /** Turns the user collapsed. Their detail rows hide; the exchange stays. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const modeRef = useRef(mode)
  modeRef.current = mode

  /** Index the current turn starts at, for anchor mode. */
  const anchorIndex = useRef(0)
  const wasRunning = useRef(props.running)

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

  const toggleTurn = useCallback((turnId: string) => {
    setFolded((current) => {
      const next = new Set(current)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
  }, [])

  const rows = virtualizer.getVirtualItems()

  return (
    <div className="thread-viewport">
      <div className="thread" ref={scroller} onScroll={onScroll}>
        {finding ? (
          <ThreadSearch items={props.items} onJump={jumpTo} onClose={() => setFinding(false)} />
        ) : null}
        <div className="thread__col">
          <div className="thread__runway" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const item = props.items[row.index]
              if (!item) return null
              const turn = turns.find((entry) => entry.index === row.index)
              const presentation = presentations.get(item.turnId)
              const live = props.running && props.activeTurn?.id === item.turnId
              const foldedDetail = folded.has(item.turnId) && !isHeadline(item)
              const compactedActivity =
                !live && presentation?.complete === true && isActivity(item) && !foldedDetail
              const activityLead =
                compactedActivity && presentation.firstActivityIndex === row.index
              const suppressed = foldedDetail || (compactedActivity && !activityLead)
              const liveActivity = live && isActivity(item)
              return (
                <div
                  key={row.key}
                  className={`thread__row ${suppressed ? 'is-suppressed' : ''} ${liveActivity ? 'is-live-activity' : ''}`}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {/* Only the first row of a turn carries the fold control, so
                      the affordance appears once per exchange rather than once
                      per line. */}
                  {turn && turn.count > 1 ? (
                    <button
                      className="turnfold"
                      onClick={() => toggleTurn(turn.turnId)}
                      title={folded.has(turn.turnId) ? 'Expand turn' : 'Collapse turn'}
                    >
                      {folded.has(turn.turnId) ? `Show ${turn.count - 1} more` : 'Collapse'}
                    </button>
                  ) : null}
                  <Row
                    item={item}
                    hidden={suppressed}
                    activity={activityLead ? presentation.activity : undefined}
                    elapsedMs={presentation?.elapsedMs}
                    live={live}
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

          {props.running ? <Plan steps={props.plan} compact /> : null}
          {!props.running ? <Diff diff={props.diff} /> : null}
          {!props.running ? <LatestResponseActions items={props.items} /> : null}
        </div>
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

/** What survives folding: the exchange itself, not the machinery. */
function isHeadline(item: Item): boolean {
  return item.type === 'message'
}

function isActivity(item: Item): boolean {
  return item.type !== 'message' && item.type !== 'error'
}

function Row({
  item,
  hidden,
  activity,
  elapsedMs,
  live,
  showWorkingRail,
  startedAt,
  showCompletionRail,
}: {
  item: Item
  hidden: boolean
  activity: Item[] | undefined
  elapsedMs: number | undefined
  live: boolean
  showWorkingRail: boolean
  startedAt: number | undefined
  showCompletionRail: boolean
}) {
  if (hidden) return null

  if (activity) {
    return <CompletionRail activity={activity} elapsedMs={elapsedMs ?? 0} />
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
    return (
      <>
        {showWorkingRail && startedAt !== undefined ? <WorkingRail startedAt={startedAt} /> : null}
        <div className="reply">
          {showCompletionRail ? <CompletionRail activity={[]} elapsedMs={elapsedMs ?? 0} /> : null}
          <Markdown text={item.text ?? ''} />
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

function CompletionRail({ activity, elapsedMs }: { activity: Item[]; elapsedMs: number }) {
  const label = `Worked for ${workedFor(elapsedMs)}`

  if (activity.length === 0) {
    return (
      <div className="activity activity--empty">
        <div className="activity__summary">{label}</div>
      </div>
    )
  }

  return (
    <details className="activity">
      <summary className="activity__summary">
        <span>{label}</span>
        <ChevronRight size={15} strokeWidth={1.8} aria-hidden />
      </summary>
      <div className="activity__body">
        {activity.map((item) => (
          <details className="activity__item" key={item.id}>
            <summary className="activity__item-head">
              <span className="activity__glyph" aria-hidden>
                {glyph(item)}
              </span>
              <span className="activity__label">{summarise(item)}</span>
              {item.exitCode !== undefined && item.exitCode !== 0 ? (
                <span className="aux__code">exit {item.exitCode}</span>
              ) : null}
              {item.durationMs !== undefined && item.durationMs >= 1000 ? (
                <span className="aux__time">{duration(item.durationMs)}</span>
              ) : null}
            </summary>
            {item.text ? <pre className="activity__out">{item.text}</pre> : null}
          </details>
        ))}
      </div>
    </details>
  )
}

function LatestResponseActions({ items }: { items: Item[] }) {
  const answer = items.findLast(
    (item) =>
      item.type === 'message' &&
      item.role === 'assistant' &&
      item.status === 'completed' &&
      Boolean(item.text),
  )

  return answer?.text ? <ResponseActions key={answer.id} text={answer.text} /> : null
}

function ResponseActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [rating, setRating] = useState<'up' | 'down'>()

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
      <button
        type="button"
        className={rating === 'up' ? 'is-selected' : ''}
        onClick={() => setRating((current) => (current === 'up' ? undefined : 'up'))}
        aria-label="Good response"
        aria-pressed={rating === 'up'}
        title="Good response"
      >
        <ThumbsUp aria-hidden />
      </button>
      <button
        type="button"
        className={rating === 'down' ? 'is-selected' : ''}
        onClick={() => setRating((current) => (current === 'down' ? undefined : 'down'))}
        aria-label="Bad response"
        aria-pressed={rating === 'down'}
        title="Bad response"
      >
        <ThumbsDown aria-hidden />
      </button>
    </div>
  )
}

function WorkingRail({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return (
    <div className="activity activity--working">
      <div className="activity__summary">Working for {workedFor(Math.max(0, now - startedAt))}</div>
    </div>
  )
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
      return item.path ? `Edited ${item.path}` : 'Edited files'
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
