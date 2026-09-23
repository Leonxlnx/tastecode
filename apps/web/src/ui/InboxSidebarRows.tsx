import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import type { SearchSnippetPart } from '@harness/contracts'
import {
  IconAlarm as Alarm,
  IconAlarmOff as AlarmOff,
  IconAlertCircle as AlertCircle,
  IconArrowBackUp as Undo,
  IconCheck as Check,
  IconCircleCheck as CircleCheck,
  IconCircleDashed as CircleDashed,
  IconGitBranch as GitBranch,
  IconHourglassLow as Hourglass,
  IconMessageCircleQuestion as MessageQuestion,
  IconPin as Pin,
  IconShieldQuestion as ShieldQuestion,
} from '@tabler/icons-react'
import { sessionSourcePresentation } from '../provider-presentation.js'
import { InboxMinuteNowContext, InboxSecondNowContext } from './InboxSidebarClock.js'
import { SnoozeButton, ThreadMenu, type ThreadCommands } from './InboxSidebarMenus.js'
import { ProviderIcon } from './ProviderIcon.js'
import type { Project, Session } from './Sidebar.js'
import { canHide, type Entry } from './inbox-entry.js'
import { ProjectMark, projectName } from './ProjectMark.js'
import { elapsedTime, formatWakeTime, relativeTime, wakeCountdown } from './inbox-sidebar-time.js'

type RowProps = Entry & {
  current: boolean
  selected: boolean
  eagerActions: boolean
  menuEntries: Entry[] | undefined
  scope: string
  jumpLabel: string | undefined
  commands: ThreadCommands
}

type StatusTone = 'working' | 'queued' | 'approval' | 'input' | 'failed' | 'woke' | 'done'
type StatusPresentation = { tone: StatusTone; label: string }

/** What the card's top-right slot says instead of a time, in priority order. */
export function threadStatus(session: Session): StatusPresentation | undefined {
  if (session.status === 'approval') return { tone: 'approval', label: 'Approval' }
  if (session.status === 'input') return { tone: 'input', label: 'Input' }
  if (session.status === 'starting' || session.status === 'working') {
    return { tone: 'working', label: 'Working' }
  }
  if (session.status === 'queued') return { tone: 'queued', label: 'Queued' }
  if (session.status === 'failed') return { tone: 'failed', label: 'Failed' }
  if (session.lifecycle.state === 'active' && session.lifecycle.wokeAt !== undefined) {
    return { tone: 'woke', label: 'Woke' }
  }
  if (session.status === 'ready' || session.unread) return { tone: 'done', label: 'Done' }
  return undefined
}

function StatusIcon(props: { tone: StatusTone }) {
  const size = 14
  switch (props.tone) {
    case 'working':
      return <CircleDashed size={size} aria-hidden />
    case 'queued':
      return <Hourglass size={size} aria-hidden />
    case 'approval':
      return <ShieldQuestion size={size} aria-hidden />
    case 'input':
      return <MessageQuestion size={size} aria-hidden />
    case 'failed':
      return <AlertCircle size={size} aria-hidden />
    case 'woke':
      return <Alarm size={size} aria-hidden />
    case 'done':
      return <CircleCheck size={size} aria-hidden />
  }
}

export function activityAt(session: Session): number {
  return session.statusSince ?? session.createdAt
}

function settledAt(session: Session): number {
  return session.lifecycle.state === 'settled' ? session.lifecycle.settledAt : 0
}

export function wakeAt(session: Session): number {
  return session.lifecycle.state === 'snoozed' ? session.lifecycle.wakeAt : 0
}

type StaticLabels = { project: Project; prefix: string; summary: string[] }
const staticLabels = new WeakMap<Session, StaticLabels>()

/** Title, project, branch, and provider only change with the session object, so they are built once. */
function labelsFor(entry: Entry): StaticLabels {
  const { project, session } = entry
  const cached = staticLabels.get(session)
  if (cached?.project === project) return cached
  const provider = sessionSourcePresentation(session.provider, session.agent).label
  const name = projectName(project)
  const branch = session.worktreeBranch
  const labels = {
    project,
    prefix: `${session.title}, ${name}, ${provider}${branch ? `, isolated on ${branch}` : ''}`,
    summary: [session.title, name, ...(branch ? [`Branch ${branch}`] : []), provider],
  }
  staticLabels.set(session, labels)
  return labels
}

/** Accessible name: title, project, provider, then the live state. */
function rowLabel(entry: Entry, now: number): string {
  const { session } = entry
  const status = threadStatus(session)
  const state =
    session.lifecycle.state === 'snoozed'
      ? `Snoozed until ${formatWakeTime(session.lifecycle.wakeAt, now)}`
      : session.lifecycle.state === 'settled'
        ? `Settled ${ago(session.lifecycle.settledAt, now)}`
        : status
          ? status.label
          : relativeTime(activityAt(session), now)
  return `${labelsFor(entry).prefix}, ${state}`
}

/** Hover summary. Native, so it costs nothing until the pointer rests. */
function rowSummary(entry: Entry, now: number): string {
  const { session } = entry
  const lifecycle =
    session.lifecycle.state === 'snoozed'
      ? [`Snoozed until ${formatWakeTime(session.lifecycle.wakeAt, now)}`]
      : session.lifecycle.state === 'settled'
        ? [`Settled ${ago(session.lifecycle.settledAt, now)}`]
        : []
  return [...labelsFor(entry).summary, ...lifecycle].join('\n')
}

function ago(at: number, now: number): string {
  const label = relativeTime(at, now)
  return label === 'now' ? 'just now' : `${label} ago`
}

function useEntry(project: Project, session: Session): Entry {
  return useMemo(() => ({ project, session }), [project, session])
}

function useRowTarget(
  id: string,
  commands: ThreadCommands,
): [RefObject<HTMLElement | null>, (node: HTMLElement | null) => void] {
  const target = useRef<HTMLElement | null>(null)
  const register = useRef((node: HTMLElement | null) => {
    target.current = node
    commands.register(id, node)
  })
  return [target, register.current]
}

function rowKeyDown(event: ReactKeyboardEvent<HTMLElement>, id: string, commands: ThreadCommands) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    commands.navigate(id, event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Escape') {
    commands.clearSelection()
  }
}

/**
 * Keeps the accessible name and hover summary current without re-rendering the
 * row. The row renders its first labels itself; this follows the clock.
 */
function useLiveLabels(target: RefObject<HTMLElement | null>, entry: Entry, now: number) {
  useEffect(() => {
    const node = target.current
    if (!node) return
    node.setAttribute('aria-label', rowLabel(entry, now))
    node.title = rowSummary(entry, now)
  }, [entry, now, target])
}

/** Pinned and active threads: project, status, title, branch, and provider. */
export const ThreadCard = memo(function ThreadCard(props: RowProps) {
  const { session, commands } = props
  const [renaming, setRenaming] = useState(false)
  const [actionsRequested, setActionsRequested] = useState(false)
  const [target, register] = useRowTarget(session.id, commands)
  const hideable = canHide(session)
  const actionsReady = props.eagerActions || actionsRequested
  const entry = useEntry(props.project, session)
  const presentation = sessionSourcePresentation(session.provider, session.agent)

  const className = `thread-card${props.current ? ' is-current' : ''}${
    props.selected ? ' is-selected' : ''
  }${hideable ? ' has-actions' : ''}${session.unread || threadStatus(session)?.tone === 'input' ? ' is-unread' : ''}`

  const top = (
    <span className="thread-card__top">
      <ProjectMark project={props.project} />
      <span className="thread-card__project">{projectName(props.project)}</span>
      {session.pinned ? (
        <span className="thread-card__pin" role="img" aria-label="Pinned">
          <Pin size={12} aria-hidden />
        </span>
      ) : null}
      <span className="thread-card__status">
        <CardClock entry={entry} target={target} />
      </span>
    </span>
  )
  const meta = (
    <span className="thread-card__meta">
      {session.worktreeBranch ? (
        <span className="thread-card__branch">
          <GitBranch size={12} aria-hidden />
          <span>{session.worktreeBranch}</span>
        </span>
      ) : null}
      <span className="thread-card__provider" aria-hidden>
        <ProviderIcon mark={presentation.mark} size={13} />
      </span>
    </span>
  )

  return (
    <li
      className={className}
      data-motion-key={session.id}
      data-archive-session-id={session.id}
      draggable={!renaming}
      onDragStart={(event) => commands.dragStart(event, session.id)}
      onDragEnd={commands.dragEnd}
      onPointerEnter={() => setActionsRequested(true)}
      onFocusCapture={() => setActionsRequested(true)}
    >
      {renaming ? (
        <div className="thread-card__main is-renaming">
          {top}
          <RenameInput
            value={session.title}
            onCancel={() => setRenaming(false)}
            onCommit={(title) => {
              commands.rename(session.id, title)
              setRenaming(false)
            }}
          />
          {meta}
        </div>
      ) : (
        <button
          ref={register}
          className="thread-card__main"
          type="button"
          aria-label={rowLabel(entry, Date.now())}
          title={rowSummary(entry, Date.now())}
          aria-current={props.current ? 'page' : undefined}
          onClick={(event) => commands.choose(event, session.id)}
          onDoubleClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey) setRenaming(true)
          }}
          onContextMenu={() => commands.prepareContextMenu(session.id)}
          onKeyDown={(event) => rowKeyDown(event, session.id, commands)}
        >
          {top}
          <span className="thread-card__title">{session.title}</span>
          {meta}
        </button>
      )}
      {hideable && actionsReady && !renaming ? (
        <span className="thread-card__actions">
          <SnoozeButton
            label={`Snooze ${session.title}`}
            onSnooze={(at) => commands.snooze([session.id], at)}
            onCustom={() => commands.customSnooze([session.id])}
          />
          <button
            type="button"
            className="thread-card__settle"
            aria-label={`Settle ${session.title}`}
            title="Settle thread"
            onClick={() => commands.settle([session.id])}
          >
            <Check size={13} aria-hidden />
            <span>Settle</span>
          </button>
        </span>
      ) : null}
      {!renaming ? (
        <ThreadMenu
          entry={entry}
          entries={props.menuEntries}
          scope={props.scope}
          target={target}
          commands={commands}
          onRename={() => setRenaming(true)}
        />
      ) : null}
      {props.jumpLabel ? <JumpHint label={props.jumpLabel} /> : null}
    </li>
  )
})

/** Picks the slowest clock that keeps this card's label accurate. */
function CardClock(props: { entry: Entry; target: RefObject<HTMLElement | null> }) {
  const status = threadStatus(props.entry.session)
  if (status?.tone === 'working') return <SecondCardClock {...props} />
  if (!status) return <MinuteCardClock {...props} />
  return <StaticCardStatus {...props} />
}

function SecondCardClock(props: { entry: Entry; target: RefObject<HTMLElement | null> }) {
  const now = useContext(InboxSecondNowContext)
  useLiveLabels(props.target, props.entry, now)
  return (
    <span className="thread-status is-working">
      <StatusIcon tone="working" />
      <span>Working</span>
      <span className="thread-status__elapsed">
        {elapsedTime(activityAt(props.entry.session), now)}
      </span>
    </span>
  )
}

function MinuteCardClock(props: { entry: Entry; target: RefObject<HTMLElement | null> }) {
  const now = useContext(InboxMinuteNowContext)
  useLiveLabels(props.target, props.entry, now)
  return <span className="thread-time">{relativeTime(activityAt(props.entry.session), now)}</span>
}

function StaticCardStatus(props: { entry: Entry; target: RefObject<HTMLElement | null> }) {
  const status = threadStatus(props.entry.session)!
  // Rendered once per status change; the label does not depend on time.
  const [now] = useState(Date.now)
  useLiveLabels(props.target, props.entry, now)
  return (
    <span className={`thread-status is-${status.tone}`}>
      <StatusIcon tone={status.tone} />
      <span>{status.label}</span>
    </span>
  )
}

/** Snoozed and settled threads: one quiet line that recedes until hovered. */
export const ThreadRow = memo(function ThreadRow(props: RowProps) {
  const { session, commands } = props
  const [renaming, setRenaming] = useState(false)
  const [target, register] = useRowTarget(session.id, commands)
  const snoozed = session.lifecycle.state === 'snoozed'
  const entry = useEntry(props.project, session)

  return (
    <li
      className={`thread-row${props.current ? ' is-current' : ''}${
        props.selected ? ' is-selected' : ''
      }${snoozed ? ' is-snoozed' : ' is-settled'}`}
      data-motion-key={session.id}
      data-archive-session-id={session.id}
      draggable={!renaming}
      onDragStart={(event) => commands.dragStart(event, session.id)}
      onDragEnd={commands.dragEnd}
    >
      {renaming ? (
        <div className="thread-row__main is-renaming">
          <ProjectMark project={props.project} />
          <RenameInput
            value={session.title}
            onCancel={() => setRenaming(false)}
            onCommit={(title) => {
              commands.rename(session.id, title)
              setRenaming(false)
            }}
          />
        </div>
      ) : (
        <button
          ref={register}
          className="thread-row__main"
          type="button"
          aria-label={rowLabel(entry, Date.now())}
          title={rowSummary(entry, Date.now())}
          aria-current={props.current ? 'page' : undefined}
          onClick={(event) => commands.choose(event, session.id)}
          onDoubleClick={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.shiftKey) setRenaming(true)
          }}
          onContextMenu={() => commands.prepareContextMenu(session.id)}
          onKeyDown={(event) => rowKeyDown(event, session.id, commands)}
        >
          <ProjectMark project={props.project} />
          <span className="thread-row__title">{session.title}</span>
          {session.pinned ? (
            <span className="thread-row__pin" role="img" aria-label="Pinned">
              <Pin size={12} aria-hidden />
            </span>
          ) : null}
          <span className="thread-row__time">
            <RowClock entry={entry} target={target} />
          </span>
        </button>
      )}
      {!renaming ? (
        <button
          type="button"
          className="thread-row__action"
          aria-label={snoozed ? `Wake ${session.title} now` : `Un-settle ${session.title}`}
          title={snoozed ? 'Wake thread now' : 'Un-settle thread'}
          onClick={() => (snoozed ? commands.wake([session.id]) : commands.unsettle([session.id]))}
        >
          {snoozed ? <AlarmOff size={13} aria-hidden /> : <Undo size={14} aria-hidden />}
        </button>
      ) : null}
      {!renaming ? (
        <ThreadMenu
          entry={entry}
          entries={props.menuEntries}
          scope={props.scope}
          target={target}
          commands={commands}
          onRename={() => setRenaming(true)}
        />
      ) : null}
      {props.jumpLabel ? <JumpHint label={props.jumpLabel} /> : null}
    </li>
  )
})

function RowClock(props: { entry: Entry; target: RefObject<HTMLElement | null> }) {
  const now = useContext(InboxMinuteNowContext)
  useLiveLabels(props.target, props.entry, now)
  const { session } = props.entry
  if (session.lifecycle.state === 'snoozed') {
    return <span className="thread-row__wake">{wakeCountdown(session.lifecycle.wakeAt, now)}</span>
  }
  return <span>{relativeTime(settledAt(session), now)}</span>
}

/** One search hit. Focus stays in the search field, which owns the keyboard. */
export const SearchResultRow = memo(function SearchResultRow(props: {
  entry: Entry
  index: number
  highlighted: boolean
  current: boolean
  snippet: SearchSnippetPart[] | undefined
  onHighlight: (index: number) => void
  onOpen: (index: number) => void
}) {
  const { project, session } = props.entry
  const now = useContext(InboxMinuteNowContext)
  return (
    <li role="presentation">
      <button
        id={searchResultId(props.index)}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={props.highlighted}
        aria-current={props.current ? 'page' : undefined}
        aria-label={`${session.title}, ${projectName(project)}`}
        className={`thread-result${props.highlighted ? ' is-highlighted' : ''}${
          props.current ? ' is-current' : ''
        }`}
        onMouseMove={() => props.onHighlight(props.index)}
        onClick={() => props.onOpen(props.index)}
      >
        <ProjectMark project={project} />
        <span className="thread-result__body">
          <span className="thread-result__line">
            <span className="thread-result__title">{session.title}</span>
            <span className="thread-result__time">
              {session.lifecycle.state === 'settled'
                ? relativeTime(settledAt(session), now)
                : relativeTime(activityAt(session), now)}
            </span>
          </span>
          {props.snippet ? (
            <span className="thread-result__snippet">
              {props.snippet.map((part, index) =>
                part.highlighted ? <mark key={index}>{part.text}</mark> : part.text,
              )}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  )
})

export function searchResultId(index: number): string {
  return `thread-search-result-${index}`
}

/** Floats over the row while the jump modifier is held; never moves the layout. */
function JumpHint(props: { label: string }) {
  return (
    <span className="thread-jump" aria-hidden>
      {props.label}
    </span>
  )
}

function RenameInput(props: {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(props.value)
  const input = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const commit = () => {
    const next = value.trim()
    if (next && next !== props.value) props.onCommit(next)
    else props.onCancel()
  }
  return (
    <input
      ref={input}
      className="thread-rename"
      value={value}
      aria-label={`Rename ${props.value}`}
      spellCheck={false}
      onChange={(event) => setValue(event.currentTarget.value)}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onBlur={commit}
      onClick={(event: ReactMouseEvent) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (composing.current) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          props.onCancel()
        }
      }}
    />
  )
}
