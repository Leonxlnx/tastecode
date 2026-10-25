import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  IconAlertCircle as CircleAlert,
  IconCircleDashed as CircleDashed,
  IconClock as Clock,
  IconFiles as Files,
  IconListDetails as PlanIcon,
  IconMessageCircle as WorkIcon,
  IconArrowBackUp as Restore,
  IconCheck as Check,
  IconFileDiff as FileDiff,
  IconFolder as Folder,
  IconGitBranch as GitBranch,
  IconHandStop as HandStop,
  IconHistory as History,
  IconLoader2 as LoaderCircle,
  IconMessageCircleQuestion as AskAbout,
  IconX as Cross,
} from '@tabler/icons-react'
import type { ThreadFrameStore } from '../thread-frame-store.js'
import type { ThreadState } from '../thread-state.js'
import { checkpointForItem, createCheckpointIndex } from '../checkpoint-index.js'
import type { ProviderMark } from '../model-catalog.js'
import {
  briefClock,
  briefDuration,
  CHECK_LABELS,
  checkDuration,
  deriveBrief,
  turnsLabel,
  type BriefAsk,
  type BriefCheck,
  type BriefCheckKind,
  type BriefFile,
  type BriefTurn,
} from './brief.js'
import { CopyButton } from './CopyButton.js'
import { FileTypeIcon } from './FileTypeIcon.js'
import { Markdown } from './Markdown.js'
import { ProviderIcon } from './ProviderIcon.js'
import type { Checkpoint } from './RollbackDialog.js'
import '../styles/brief.css'

/** While a turn runs, the page follows it at most this often. */
export const BRIEF_REFRESH_MS = 500
/** Turns past this many read as ticks on one rule instead of labelled stops. */
const TRACK_STOPS = 6
/** Files past this many fold behind a "more" row. */
const FILES_SHOWN = 8
/** Earlier asks past this many fold behind one row. */
const ASKS_SHOWN = 2

export type BriefSourceLabel = {
  /** The provider or agent, as people say it: "Claude Code", "Codex", "Grok". */
  name: string
  mark: ProviderMark
  model?: string | undefined
  effort?: string | undefined
}

export type BriefProps = {
  frameStore: ThreadFrameStore
  threadId: string
  title: string | undefined
  projectPath: string | undefined
  projectName: string | undefined
  branch: string | undefined
  source: BriefSourceLabel | undefined
  /** The chat's history is still being read. */
  loading: boolean
  checkpoints: readonly Checkpoint[]
  toggleShortcut: string | undefined
  onOpenReview: (path?: string) => void
  onAskAbout: (text: string) => void
  onShowConversation: () => void
  onRevertCheckpoint: (checkpoint: Checkpoint) => void
  onOpenRollback: () => void
  onLoadCompleteHistory?: ((threadId: string, signal: AbortSignal) => Promise<void>) | undefined
}

/**
 * The structural snapshot the page reads: text deltas never reach it, and
 * while a turn runs it follows structural changes at most every 500 ms. A
 * settled chat updates at once.
 */
function useBriefSnapshot(frameStore: ThreadFrameStore): ThreadState {
  const [snapshot, setSnapshot] = useState(frameStore.getStructureSnapshot)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const flush = () => {
      timer = undefined
      last = performance.now()
      setSnapshot(frameStore.getStructureSnapshot())
    }
    const onChange = () => {
      if (!frameStore.getStructureSnapshot().running) {
        if (timer !== undefined) clearTimeout(timer)
        flush()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(flush, Math.max(0, BRIEF_REFRESH_MS - (performance.now() - last)))
    }
    const unsubscribe = frameStore.subscribeStructure(onChange)
    onChange()
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [frameStore])
  return snapshot
}

/** One shared second for the running clocks on the page. */
const secondListeners = new Set<() => void>()
let secondTimer: ReturnType<typeof setInterval> | undefined
let secondNow = Date.now()
function subscribeSecond(listener: () => void): () => void {
  secondListeners.add(listener)
  if (secondListeners.size === 1) {
    secondNow = Date.now()
    secondTimer = setInterval(() => {
      secondNow = Date.now()
      for (const each of secondListeners) each()
    }, 1000)
  }
  return () => {
    secondListeners.delete(listener)
    if (secondListeners.size === 0) {
      clearInterval(secondTimer)
      secondTimer = undefined
    }
  }
}
const readSecond = () => secondNow

function Elapsed(props: { since: number }) {
  const now = useSyncExternalStore(subscribeSecond, readSecond, readSecond)
  return <span className="brief__clock">{briefClock(now - props.since)}</span>
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** "13:58" today, "Thu 16:12" this week, "Oct 12" before. */
function briefTime(at: number, now = Date.now()): string {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return TIME.format(date)
  if (now - at < 6 * 86_400_000) return DAY_TIME.format(date)
  return DATE.format(date)
}

export const BriefView = memo(function BriefView(props: BriefProps) {
  const snapshot = useBriefSnapshot(props.frameStore)
  const [asOfTurn, setAsOfTurn] = useState<number>()
  const brief = useMemo(
    () => deriveBrief(snapshot, { projectPath: props.projectPath, asOfTurn }),
    [snapshot, props.projectPath, asOfTurn],
  )
  const history = useCompleteHistory(
    props.threadId,
    snapshot.olderCursor,
    props.onLoadCompleteHistory,
  )
  const scroller = useRef<HTMLDivElement>(null)
  const agent = props.source?.name ?? 'The agent'

  // A different moment is a different page: start it from the top.
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [asOfTurn])

  const checkpointIndex = useMemo(
    () => createCheckpointIndex(props.checkpoints),
    [props.checkpoints],
  )
  const restorePoint = useMemo(() => {
    if (!brief.asOf) return undefined
    const next = brief.turns[brief.asOf.number]
    const prompt = next?.promptItem
    return prompt ? checkpointForItem(prompt, checkpointIndex, snapshot.items) : undefined
  }, [brief.asOf, brief.turns, checkpointIndex, snapshot.items])

  const backToNow = useCallback(() => setAsOfTurn(undefined), [])
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && asOfTurn !== undefined && !event.defaultPrevented) {
      event.preventDefault()
      backToNow()
    }
  }

  const latest = brief.turns.at(-1)
  const workChat =
    brief.plan !== undefined || brief.changes.files.length > 0 || brief.checks.length > 0
  /** The page is following a running turn (not reading an earlier moment). */
  const live = brief.running && !brief.asOf

  return (
    <div className="brief-shell">
      <div
        className="brief"
        ref={scroller}
        onKeyDown={onKeyDown}
        data-testid="brief"
        data-as-of={brief.asOf ? brief.asOf.number : undefined}
      >
        <article className="brief__col" aria-label="Brief">
          <header className="brief__head">
            <h1 className="brief__title">{props.title ?? 'New chat'}</h1>
            <p className="brief__context">
              {props.projectName ? (
                <span className="brief__fact">
                  <Folder size={14} aria-hidden />
                  {props.projectName}
                </span>
              ) : null}
              {props.branch ? (
                <span className="brief__fact">
                  <GitBranch size={14} aria-hidden />
                  {props.branch}
                </span>
              ) : null}
              {props.source ? (
                <span className="brief__fact">
                  <ProviderIcon mark={props.source.mark} size={13} className="brief__mark" />
                  {props.source.model ?? props.source.name}
                  {props.source.effort ? (
                    <span className="brief__quiet">&nbsp;· {props.source.effort}</span>
                  ) : null}
                </span>
              ) : null}
              {brief.turns[0] ? (
                <span className="brief__fact">
                  <Clock size={14} aria-hidden />
                  {brief.partial ? 'Last ' : ''}
                  {brief.turns.length} {brief.turns.length === 1 ? 'turn' : 'turns'} since{' '}
                  {briefTime(brief.turns[0].startedAt)}
                </span>
              ) : null}
              {brief.running && latest && !brief.asOf ? (
                <span className="brief__fact brief__fact--live">
                  <span className="brief__pulse" aria-hidden />
                  working <Elapsed since={latest.startedAt} />
                </span>
              ) : null}
            </p>
          </header>

          {brief.turns.length > 1 ? (
            <TurnTrack
              turns={brief.turns}
              asOf={brief.asOf?.number}
              running={snapshot.running}
              onSelect={(number) => setAsOfTurn(number === brief.turns.length ? undefined : number)}
            />
          ) : null}

          {history !== 'idle' ? (
            <p className="brief__note" role="status">
              {history === 'reading' ? (
                <>
                  <span className="brief__spinner" aria-hidden>
                    <LoaderCircle size={13} />
                  </span>
                  Reading the earlier turns of this chat…
                </>
              ) : (
                'The earlier turns of this chat could not be read; the Brief starts at the oldest loaded turn.'
              )}
            </p>
          ) : null}

          {brief.asOf ? (
            <div className="brief-asof" role="status">
              <History size={15} aria-hidden />
              <p className="brief-asof__text">
                The chat <b>as it stood after turn {brief.asOf.number}</b>
                {brief.asOf.endedAt ? ` (${briefTime(brief.asOf.endedAt)})` : ''}. Reading it
                changes no files.
              </p>
              {props.checkpoints.length > 0 ? (
                <button
                  type="button"
                  className="brief-btn brief-btn--quiet"
                  onClick={() =>
                    restorePoint ? props.onRevertCheckpoint(restorePoint) : props.onOpenRollback()
                  }
                >
                  <Restore size={14} aria-hidden />
                  {restorePoint ? 'Restore files to this point…' : 'Restore points…'}
                </button>
              ) : null}
              <button type="button" className="brief-btn" onClick={backToNow}>
                Back to now
                <kbd className="brief-kbd">Esc</kbd>
              </button>
            </div>
          ) : null}

          {props.loading && brief.turns.length === 0 ? (
            <p className="brief__note">Reading this chat…</p>
          ) : null}

          {brief.needsYou.length > 0 ? (
            <Section label="Needs you" tone="needs">
              {brief.needsYou.map((ask) => (
                <AskCard
                  key={ask.id}
                  ask={ask}
                  agent={agent}
                  shortcut={props.toggleShortcut}
                  onShowConversation={props.onShowConversation}
                />
              ))}
            </Section>
          ) : null}

          {brief.stopped ? (
            <Section label="Stopped" tone={brief.stopped.kind === 'failed' ? 'failed' : undefined}>
              <div className="brief-stop">
                <span className="brief-stop__glyph" aria-hidden>
                  {brief.stopped.kind === 'failed' ? (
                    <CircleAlert size={16} />
                  ) : (
                    <HandStop size={16} />
                  )}
                </span>
                <div className="brief-stop__body">
                  <p className="brief-stop__title">
                    {brief.stopped.kind === 'failed'
                      ? brief.stopped.message
                      : `You stopped turn ${brief.stopped.turn}.`}
                  </p>
                  <p className="brief-stop__detail">
                    {[
                      brief.stopped.ranMs !== undefined
                        ? `Turn ${brief.stopped.turn} ran ${briefDuration(brief.stopped.ranMs)}`
                        : `Turn ${brief.stopped.turn}`,
                      brief.stopped.step
                        ? `reached step ${brief.stopped.step.index} of ${brief.stopped.step.count}`
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    .
                  </p>
                </div>
                {brief.stopped.kind === 'failed' && brief.stopped.message ? (
                  <div className="brief-stop__actions">
                    <CopyButton
                      text={brief.stopped.message}
                      label="Copy error"
                      title="Copy error"
                    />
                  </div>
                ) : null}
              </div>
            </Section>
          ) : null}

          {brief.asked ? (
            <Section label="Asked" sub={`turn ${brief.asked.latest.number}`}>
              <AskedNow text={brief.asked.latest.prompt} />
              <EarlierAsks turns={brief.asked.earlier} onSelect={(number) => setAsOfTurn(number)} />
            </Section>
          ) : null}

          {brief.now ? (
            <Section label="Now">
              <div className="brief-now">
                <span className="brief-row__glyph" aria-hidden>
                  <span className="brief__pulse" />
                </span>
                <span className="brief-now__verb">{brief.now.verb}</span>
                {brief.now.object ? (
                  <span className={`brief-now__object${brief.now.command ? ' is-command' : ''}`}>
                    {brief.now.object}
                  </span>
                ) : null}
                <span className="brief-now__meta">
                  {brief.now.step ? (
                    <span>
                      step {brief.now.step.index} of {brief.now.step.count}
                    </span>
                  ) : null}
                  <Elapsed since={brief.now.startedAt} />
                </span>
              </div>
              {brief.now.note ? <p className="brief-now__note">{brief.now.note}</p> : null}
            </Section>
          ) : null}

          {brief.plan ? (
            <Section label="Plan" sub={`turn ${brief.plan.turn}`}>
              {brief.plan.status === 'shared' ? (
                <ul
                  className="brief-rows"
                  aria-label={`Plan, ${brief.plan.done} of ${brief.plan.steps.length} done`}
                >
                  {brief.plan.steps.map((step, index) => {
                    const stoppedHere =
                      step.status === 'running' && latest?.state !== 'running' && !brief.asOf
                    return (
                      <li
                        key={`${index}:${step.text}`}
                        className={`brief-row brief-step is-${step.status}`}
                      >
                        <span className="brief-row__glyph" aria-hidden>
                          {step.status === 'done' ? (
                            <Check size={14} />
                          ) : step.status === 'running' && !stoppedHere ? (
                            <span className="brief__spinner">
                              <LoaderCircle size={13} />
                            </span>
                          ) : (
                            <span className="brief-ring" />
                          )}
                        </span>
                        <span className="brief-row__text">{step.text}</span>
                        <span className="brief-row__meta brief-row__hide">
                          {step.status === 'running'
                            ? stoppedHere
                              ? 'stopped here'
                              : 'now'
                            : null}
                        </span>
                        <RowAction
                          label={`Ask about the step “${step.text}”`}
                          onClick={() => props.onAskAbout(`About the step “${step.text}”: `)}
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <Quiet icon={<PlanIcon size={14} />}>
                  {brief.plan.status === 'not-kept'
                    ? `Only the latest turn’s plan is kept, so turn ${brief.plan.turn}’s is not shown.`
                    : live
                      ? 'No plan shared yet.'
                      : `${agent} shared no plan for turn ${brief.plan.turn}.`}
                </Quiet>
              )}
            </Section>
          ) : null}

          {/* While a turn runs, empty Changes and Checks wait until there is something to say. */}
          {workChat && !(live && brief.changes.files.length === 0) ? (
            <Section
              label="Changes"
              sub={brief.asOf ? `up to turn ${brief.asOf.number}` : 'whole chat'}
            >
              <Changes
                files={brief.changes.files}
                added={brief.changes.added}
                removed={brief.changes.removed}
                onOpenReview={props.onOpenReview}
                onAskAbout={props.onAskAbout}
              />
            </Section>
          ) : null}

          {workChat && !(live && brief.checks.length === 0) ? (
            <Section label="Checks" sub="latest run of each">
              <Checks
                checks={brief.checks}
                notRun={brief.notRun}
                asOfTurn={brief.asOf?.number}
                onAskAbout={props.onAskAbout}
              />
            </Section>
          ) : null}

          {!workChat && brief.turns.length > 0 ? (
            <Section label="Work">
              <Quiet icon={<WorkIcon size={14} />}>
                Nothing changed and nothing was checked
                {brief.commandCount > 0
                  ? `; ${agent} ran ${brief.commandCount} ${brief.commandCount === 1 ? 'command' : 'commands'}`
                  : ''}
                .
              </Quiet>
            </Section>
          ) : null}

          {brief.turns.length > 0 ? (
            <Section label="Answer" sub={brief.answer ? `turn ${brief.answer.turn}` : undefined}>
              {brief.answerPending && latest ? (
                <Quiet icon={<span className="brief__pulse" />} lead>
                  Turn {latest.number} has no answer yet.
                  {brief.answer ? ' The latest one is below.' : ''}
                </Quiet>
              ) : null}
              {brief.answer ? (
                <Answer
                  key={`${brief.answer.turn}:${brief.answer.text.length}`}
                  text={brief.answer.text}
                  projectPath={props.projectPath}
                  meta={[
                    brief.answer.partial ? 'stopped while writing' : undefined,
                    brief.answer.workedMs !== undefined
                      ? `worked ${briefDuration(brief.answer.workedMs)}`
                      : undefined,
                    briefTime(brief.answer.at),
                  ]}
                />
              ) : !brief.answerPending ? (
                <Quiet icon={<Clock size={14} />}>
                  {brief.stopped
                    ? `No answer: the turn stopped before ${agent} wrote one.`
                    : 'No answer in this chat yet.'}
                </Quiet>
              ) : null}
            </Section>
          ) : null}
        </article>
      </div>
    </div>
  )
})

type HistoryRead = 'idle' | 'reading' | 'failed'

/** "Since the chat began" needs every turn: read the older ones once, on open. */
function useCompleteHistory(
  threadId: string,
  olderCursor: string | undefined,
  load: BriefProps['onLoadCompleteHistory'],
): HistoryRead {
  const [state, setState] = useState<HistoryRead>('idle')
  const wanted = Boolean(olderCursor && load)
  useEffect(() => {
    if (!wanted || !load) return
    const controller = new AbortController()
    setState('reading')
    load(threadId, controller.signal).then(
      () => {
        if (!controller.signal.aborted) setState('idle')
      },
      () => {
        if (!controller.signal.aborted) setState('failed')
      },
    )
    return () => controller.abort()
  }, [load, threadId, wanted])
  return wanted || state === 'failed' ? state : 'idle'
}

function Section(props: {
  label: string
  sub?: string | undefined
  tone?: 'needs' | 'failed' | undefined
  children: ReactNode
}) {
  return (
    <section className={`brief-sec${props.tone ? ` is-${props.tone}` : ''}`}>
      <h2 className="brief-sec__label">
        <span className="brief-sec__name">
          {props.tone === 'needs' ? <span className="brief-sec__dot" aria-hidden /> : null}
          {props.label}
        </span>
        {props.sub ? <span className="brief-sec__sub">{props.sub}</span> : null}
      </h2>
      <div className="brief-sec__body">{props.children}</div>
    </section>
  )
}

/** A quiet line in a section, its glyph in the rows' glyph column so its words line up. */
function Quiet(props: { icon: ReactNode; lead?: boolean; after?: boolean; children: ReactNode }) {
  return (
    <p
      className={`brief-quiet${props.lead ? ' brief-quiet--lead' : ''}${props.after ? ' brief-quiet--after' : ''}`}
    >
      <span className="brief-row__glyph" aria-hidden>
        {props.icon}
      </span>
      <span>{props.children}</span>
    </p>
  )
}

function RowAction(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="brief-row__action"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <AskAbout size={14} aria-hidden />
      Ask about
    </button>
  )
}

function TurnTrack(props: {
  turns: readonly BriefTurn[]
  asOf: number | undefined
  running: boolean
  onSelect: (number: number) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = props.asOf ?? props.turns.length
  const [focusIndex, setFocusIndex] = useState(selected - 1)
  useEffect(() => setFocusIndex(selected - 1), [selected])
  const ticks = props.turns.length > TRACK_STOPS
  const last = props.turns.length - 1

  const onKeyDown = (event: ReactKeyboardEvent, index: number) => {
    let next: number | undefined
    if (event.key === 'ArrowRight') next = Math.min(last, index + 1)
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === undefined) return
    event.preventDefault()
    setFocusIndex(next)
    buttons.current[next]?.focus()
  }

  const stop = (turn: BriefTurn, index: number) => {
    const isSelected = turn.number === selected
    const isNow = index === last
    const ask = turn.prompt ? `: ${oneLine(turn.prompt, 90)}` : ''
    return (
      <button
        key={turn.id}
        ref={(element) => {
          buttons.current[index] = element
        }}
        type="button"
        className={`brief-stop-node${isSelected ? ' is-selected' : ''}${isNow ? ' is-now' : ''}${isNow && props.running ? ' is-running' : ''}${turn.state === 'failed' ? ' is-failed' : ''}`}
        aria-current={isSelected ? 'step' : undefined}
        aria-label={
          isNow ? `Turn ${turn.number}, now${ask}` : `Show the chat after turn ${turn.number}${ask}`
        }
        tabIndex={index === focusIndex ? 0 : -1}
        onClick={() => props.onSelect(turn.number)}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        <span className="brief-stop-node__dot" aria-hidden />
        {ticks ? null : (
          <>
            <b>Turn {turn.number}</b>
            <span>{isNow && props.running ? 'now' : briefTime(turn.startedAt)}</span>
          </>
        )}
        {ticks ? (
          <span className="brief-tip" role="presentation">
            <b>
              Turn {turn.number} · {briefTime(turn.startedAt)}
            </b>
            {turn.prompt ? <span>{oneLine(turn.prompt, 80)}</span> : null}
          </span>
        ) : null}
      </button>
    )
  }

  if (!ticks) {
    return (
      <nav className="brief-track" aria-label="Turns">
        {props.turns.map((turn, index) => (
          <span key={turn.id} className="brief-track__seg">
            {index > 0 ? <span className="brief-track__rule" aria-hidden /> : null}
            {stop(turn, index)}
          </span>
        ))}
      </nav>
    )
  }
  const first = props.turns[0]!
  const lastTurn = props.turns[last]!
  return (
    <nav className="brief-track is-ticks" aria-label="Turns">
      <span className="brief-track__end">Turn 1 · {briefTime(first.startedAt)}</span>
      <span className="brief-track__ticks">
        {props.turns.map((turn, index) => (
          <span
            key={turn.id}
            className="brief-track__tick"
            style={{ left: `${(index / last) * 100}%` }}
          >
            {stop(turn, index)}
          </span>
        ))}
      </span>
      <span className="brief-track__end is-now">
        Turn {lastTurn.number} · {props.running ? 'now' : briefTime(lastTurn.startedAt)}
      </span>
    </nav>
  )
}

function AskCard(props: {
  ask: BriefAsk
  agent: string
  shortcut: string | undefined
  onShowConversation: () => void
}) {
  const { ask } = props
  return (
    <div className="brief-ask">
      <p className="brief-ask__who">
        {props.agent} {ask.kind === 'approval' ? 'asks to' : 'asks'}
        {ask.kind === 'approval' ? ` ${ask.title.toLowerCase()}` : ''} · {briefTime(ask.at)}
      </p>
      {ask.kind === 'approval' ? (
        <>
          {ask.command ? (
            <pre className="brief-ask__command">
              <span aria-hidden>$ </span>
              {ask.command}
            </pre>
          ) : ask.path ? (
            <p className="brief-ask__path">{ask.path}</p>
          ) : null}
          {ask.cwd ? (
            <p className="brief-ask__meta">in {ask.cwd === '.' ? 'the project folder' : ask.cwd}</p>
          ) : null}
          {ask.reason ? <p className="brief-ask__reason">{ask.reason}</p> : null}
        </>
      ) : (
        <>
          <p className="brief-ask__question">{ask.question}</p>
          {ask.options.length > 0 ? (
            <ol className="brief-ask__options">
              {ask.options.map((option, index) => (
                <li key={`${index}:${option}`}>
                  <kbd className="brief-kbd">{index + 1}</kbd>
                  {option}
                </li>
              ))}
            </ol>
          ) : null}
          {ask.more > 0 ? (
            <p className="brief-ask__meta">
              and {ask.more} more {ask.more === 1 ? 'question' : 'questions'}
            </p>
          ) : null}
        </>
      )}
      <div className="brief-ask__foot">
        <button
          type="button"
          className="brief-btn brief-btn--strong"
          onClick={props.onShowConversation}
        >
          {ask.kind === 'approval' ? 'Decide in the conversation' : 'Answer in the conversation'}
          {props.shortcut ? <kbd className="brief-kbd">{props.shortcut}</kbd> : null}
        </button>
      </div>
    </div>
  )
}

/** The newest ask, whole, folded past a few lines. */
function AskedNow(props: { text: string }) {
  const element = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const node = element.current
    if (!node || open) return
    setOverflows(node.scrollHeight > node.clientHeight + 1)
  }, [open, props.text])
  return (
    <>
      <p ref={element} className={`brief-asked${open ? ' is-open' : ''}`}>
        {props.text || 'An ask without text.'}
      </p>
      {overflows ? (
        <button type="button" className="brief-link" onClick={() => setOpen((value) => !value)}>
          {open ? 'Show less' : 'Show the whole ask'}
        </button>
      ) : null}
    </>
  )
}

function EarlierAsks(props: { turns: readonly BriefTurn[]; onSelect: (number: number) => void }) {
  const [open, setOpen] = useState(false)
  if (props.turns.length === 0) return null
  const folded = !open && props.turns.length > ASKS_SHOWN + 1
  const shown = folded ? props.turns.slice(0, ASKS_SHOWN) : props.turns
  const oldest = props.turns.at(-1)!
  return (
    <ul className="brief-rows brief-earlier" aria-label="Earlier asks">
      {shown.map((turn) => (
        <li key={turn.id} className="brief-row">
          <button
            type="button"
            className="brief-row__main"
            title={`Show the chat as it stood after turn ${turn.number}`}
            onClick={() => props.onSelect(turn.number)}
          >
            <span className="brief-row__glyph" aria-hidden>
              <History size={14} />
            </span>
            <span className="brief-row__text">{oneLine(turn.prompt, 200)}</span>
            <span className="brief-row__meta">
              turn {turn.number} · {briefTime(turn.startedAt)}
            </span>
          </button>
        </li>
      ))}
      {folded ? (
        <li className="brief-row">
          <button type="button" className="brief-row__main" onClick={() => setOpen(true)}>
            <span className="brief-row__glyph" aria-hidden>
              <History size={14} />
            </span>
            <span className="brief-row__text">
              {props.turns.length - ASKS_SHOWN} earlier asks, from “{oneLine(oldest.prompt, 60)}”
            </span>
            <span className="brief-row__meta">since {briefTime(oldest.startedAt)}</span>
          </button>
        </li>
      ) : null}
    </ul>
  )
}

function Changes(props: {
  files: readonly BriefFile[]
  added: number
  removed: number
  onOpenReview: (path?: string) => void
  onAskAbout: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (props.files.length === 0) {
    return <Quiet icon={<Files size={14} />}>No files changed in this chat.</Quiet>
  }
  const folded = !open && props.files.length > FILES_SHOWN + 1
  const shown = folded ? props.files.slice(0, FILES_SHOWN) : props.files
  return (
    <>
      <div className="brief-sec__head">
        <span className="brief-sec__count">
          <b>
            {props.files.length} {props.files.length === 1 ? 'file' : 'files'}
          </b>
          <Stats added={props.added} removed={props.removed} />
        </span>
        <button
          type="button"
          className="brief-btn brief-btn--quiet"
          onClick={() => props.onOpenReview()}
        >
          <FileDiff size={14} aria-hidden />
          Review all
        </button>
      </div>
      <ul className="brief-rows" aria-label="Changed files">
        {shown.map((file) => (
          <li key={file.key} className="brief-row brief-file">
            <button
              type="button"
              className="brief-row__main"
              aria-label={`${file.directory}${file.name}${file.deleted ? ', deleted' : ''}, ${file.added} added, ${file.removed} removed, ${turnsLabel(file.turns)}. Open in Review.`}
              title={`Open ${file.directory}${file.name} in Review`}
              onClick={() => props.onOpenReview(file.path)}
            >
              <span className="brief-row__glyph" aria-hidden>
                <FileTypeIcon path={file.name} />
              </span>
              <span className="brief-row__text">
                <span className="brief-file__dir">{file.directory}</span>
                <span className="brief-file__name">{file.name}</span>
              </span>
              {file.deleted ? <span className="brief-tag">deleted</span> : null}
              <Stats added={file.added} removed={file.removed} />
              <span className="brief-row__meta brief-row__hide brief-file__turns">
                {turnsLabel(file.turns)}
              </span>
            </button>
            <RowAction
              label={`Ask about ${file.directory}${file.name}`}
              onClick={() => props.onAskAbout(`About ${file.directory}${file.name}: `)}
            />
          </li>
        ))}
        {folded ? (
          <li className="brief-row">
            <button
              type="button"
              className="brief-row__main brief-more"
              onClick={() => setOpen(true)}
            >
              Show {props.files.length - FILES_SHOWN} more files
            </button>
          </li>
        ) : null}
      </ul>
    </>
  )
}

function Stats(props: { added: number; removed: number }) {
  if (props.added === 0 && props.removed === 0) return null
  return (
    <span className="brief-stats">
      {props.added > 0 ? <span className="stat stat--add">+{props.added}</span> : null}
      {props.removed > 0 ? <span className="stat stat--del">−{props.removed}</span> : null}
    </span>
  )
}

const NOT_RUN_WORDS = {
  test: 'tests',
  typecheck: 'type checks',
  lint: 'lint',
  build: 'builds',
} as const satisfies Record<BriefCheckKind, string>

function Checks(props: {
  checks: readonly BriefCheck[]
  notRun: readonly BriefCheckKind[]
  asOfTurn: number | undefined
  onAskAbout: (text: string) => void
}) {
  if (props.checks.length === 0) {
    return (
      <Quiet icon={<CircleDashed size={14} />}>
        No tests, type checks, lint or builds ran in this chat.
      </Quiet>
    )
  }
  const notRun = props.notRun.map((kind) => NOT_RUN_WORDS[kind])
  return (
    <>
      <ul className="brief-rows brief-checks" aria-label="Checks">
        {props.checks.map((check) => (
          <li key={check.kind} className={`brief-row brief-check is-${check.state}`}>
            <span className="brief-row__glyph" aria-hidden>
              {check.state === 'passed' ? (
                <Check size={14} />
              ) : check.state === 'failed' ? (
                <Cross size={14} />
              ) : check.state === 'running' ? (
                <span className="brief__spinner">
                  <LoaderCircle size={13} />
                </span>
              ) : (
                <span className="brief-ring" />
              )}
            </span>
            <span className="brief-check__label">{CHECK_LABELS[check.kind]}</span>
            <span className="brief-check__command" title={check.command}>
              {check.command}
            </span>
            <span
              className="brief-check__result"
              title={
                check.chained ? 'One exit code covers every check in this command.' : undefined
              }
            >
              {check.result}
            </span>
            <span className="brief-check__duration">
              {check.durationMs !== undefined ? checkDuration(check.durationMs) : ''}
            </span>
            <span className="brief-row__meta brief-row__hide brief-check__when">
              turn {check.turn} · {briefTime(check.at)}
            </span>
            <RowAction
              label={`Ask about ${check.command}`}
              onClick={() => props.onAskAbout(`About \`${check.command}\` (${check.result}): `)}
            />
          </li>
        ))}
      </ul>
      {notRun.length > 0 ? (
        <Quiet icon={null} after>
          {capitalize(joinWords(notRun))}{' '}
          {props.asOfTurn !== undefined
            ? `had not run by turn ${props.asOfTurn}.`
            : `${notRun.length === 1 && notRun[0] === 'lint' ? 'has' : 'have'} not run in this chat.`}
        </Quiet>
      ) : null}
    </>
  )
}

/** The last answer, folded past a screenful, with its own copy. */
function Answer(props: {
  text: string
  projectPath: string | undefined
  meta: Array<string | undefined>
}) {
  const body = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const node = body.current
    if (!node) return
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 2)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="brief-answer">
      <div
        ref={body}
        className={`reply brief-answer__body${open ? ' is-open' : ''}${overflows && !open ? ' is-folded' : ''}`}
      >
        <Markdown text={props.text} projectPath={props.projectPath} literalHtml />
      </div>
      <div className="brief-answer__meta">
        {overflows || open ? (
          <button type="button" className="brief-link" onClick={() => setOpen((value) => !value)}>
            {open ? 'Show less' : 'Show the whole answer'}
          </button>
        ) : null}
        <span>{props.meta.filter(Boolean).join(' · ')}</span>
        <CopyButton text={props.text} label="Copy answer" title="Copy answer" />
      </div>
    </div>
  )
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}
