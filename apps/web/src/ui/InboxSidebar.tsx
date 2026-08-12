import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Bell,
  CheckCheck,
  ChevronRight,
  Clock3,
  Copy,
  Ellipsis,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import {
  agentPresentation,
  providerPresentation,
  type ProviderPresentation,
} from '../provider-presentation.js'
import { Menu, MenuItem } from './Menu.js'
import type { Project, Session } from './Sidebar.js'
import { SourceIdentity } from './SourceIdentity.js'

type Entry = { project: Project; session: Session }

export type InboxActions = {
  onSettle: (id: string) => void
  onSettleMany?: ((ids: string[]) => void) | undefined
  onUnsettle: (id: string) => void
  onUnsettleMany?: ((ids: string[]) => void) | undefined
  onSnooze: (id: string, wakeAt: number) => void
  onSnoozeMany?: ((ids: string[], wakeAt: number) => void) | undefined
  onUnsnooze: (id: string) => void
  onUnsnoozeMany?: ((ids: string[]) => void) | undefined
  onKeepActive: (id: string, keepActive: boolean) => void
}

export function InboxSidebar(props: {
  projects: Project[]
  scope: string
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  actions: InboxActions
  onScopeChange: (path: string) => void
  onAddProject: () => void
  onNewSession: (preferredPath?: string, chooseProject?: boolean) => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  onArchiveSession: (id: string) => void
  onArchiveSessions?: ((ids: string[]) => void) | undefined
  pullRequestsActive?: boolean | undefined
  onOpenPullRequests?: (() => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const [settledOpen, setSettledOpen] = useState(true)
  const [settledLimit, setSettledLimit] = useState(10)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  const normalizedQuery = query.trim().toLocaleLowerCase()
  // Memoised because the parent still commits during streaming. The lifecycle
  // list only needs to be rebuilt when its actual inputs change.
  const { active, snoozed, settled, ordered } = useMemo(() => {
    const entries = props.projects
      .flatMap((project) => project.sessions.map((session) => ({ project, session })))
      .filter((entry) => !props.scope || entry.project.path === props.scope)
      .filter(
        (entry) =>
          !normalizedQuery || entry.session.title.toLocaleLowerCase().includes(normalizedQuery),
      )
    const nextActive = entries
      .filter((entry) => entry.session.lifecycle.state === 'active')
      .sort(newestFirst)
    const nextSnoozed = entries
      .filter((entry) => entry.session.lifecycle.state === 'snoozed')
      .sort((a, b) => wakeAt(a.session) - wakeAt(b.session))
    const nextSettled = entries
      .filter((entry) => entry.session.lifecycle.state === 'settled')
      .sort((a, b) => settledAt(b.session) - settledAt(a.session))
    return {
      active: nextActive,
      snoozed: nextSnoozed,
      settled: nextSettled,
      ordered: [...nextActive, ...nextSnoozed, ...nextSettled],
    }
  }, [props.projects, props.scope, normalizedQuery])

  const selectedSnoozed = snoozed.find((entry) => entry.session.id === props.activeSessionId)
  const selectedSettled = settled.find((entry) => entry.session.id === props.activeSessionId)
  const visibleSettled = normalizedQuery
    ? settled
    : withSelected(settled.slice(0, settledLimit), selectedSettled)
  const hasMatches = ordered.length > 0
  const hasRunningThread = active.some((entry) =>
    ['starting', 'working'].includes(entry.session.status),
  )

  useEffect(() => setSettledLimit(10), [props.scope])
  useEffect(() => {
    const delay = hasRunningThread ? 1_000 : 30_000
    const timer = window.setInterval(() => setNow(Date.now()), delay)
    return () => window.clearInterval(timer)
  }, [hasRunningThread])
  useEffect(() => {
    const ids = new Set(ordered.map((entry) => entry.session.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [ordered])

  const registerRow = (id: string, node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }

  const focusResult = (id: string, direction: -1 | 1) => {
    const index = ordered.findIndex((entry) => entry.session.id === id)
    if (index < 0 || ordered.length === 0) return
    const next = ordered[(index + direction + ordered.length) % ordered.length]
    if (next) rowRefs.current.get(next.session.id)?.focus()
  }

  const chooseEntry = (event: ReactMouseEvent, id: string) => {
    if (event.shiftKey && selectionAnchor) {
      const from = ordered.findIndex((entry) => entry.session.id === selectionAnchor)
      const to = ordered.findIndex((entry) => entry.session.id === id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        setSelectedIds(new Set(ordered.slice(start, end + 1).map((entry) => entry.session.id)))
        return
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelectedIds((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setSelectionAnchor(id)
      return
    }
    setSelectedIds(new Set())
    setSelectionAnchor(id)
    props.onSelectSession(id)
  }

  const prepareContextMenu = (id: string) => {
    if (selectedIds.has(id)) return
    setSelectedIds(new Set([id]))
    setSelectionAnchor(id)
  }

  const menuEntries = (entry: Entry): Entry[] =>
    selectedIds.has(entry.session.id) && selectedIds.size > 1
      ? ordered.filter((candidate) => selectedIds.has(candidate.session.id))
      : [entry]

  const clearSelection = () => setSelectedIds(new Set())
  const preferredProject =
    props.scope ||
    props.activeProjectPath ||
    (props.projects.length === 1 ? props.projects[0]?.path : '')

  return (
    <>
      <div className="inbox-toolbar">
        <div className="inbox-toolbar__primary">
          <label className="inbox-search">
            <Search size={14} aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  setQuery('')
                  return
                }
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                const target = event.key === 'ArrowDown' ? ordered[0] : ordered.at(-1)
                if (target) rowRefs.current.get(target.session.id)?.focus()
              }}
              placeholder="Search threads"
              aria-label="Search threads"
              spellCheck={false}
            />
            {query ? (
              <button type="button" aria-label="Clear thread search" onClick={() => setQuery('')}>
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </label>
          <button
            className="inbox-toolbar__new"
            type="button"
            onClick={() => {
              if (props.projects.length === 0) props.onAddProject()
              else props.onNewSession(preferredProject || undefined, props.projects.length > 1)
            }}
          >
            <SquarePen size={16} aria-hidden />
            <span>New chat</span>
          </button>
        </div>

        <div className="inbox-toolbar__projects">
          <label className="inbox__scope">
            <span className="visually-hidden">Project filter</span>
            <select
              aria-label="Sidebar project filter"
              value={props.scope}
              onChange={(event) => props.onScopeChange(event.currentTarget.value)}
            >
              <option value="">All projects</option>
              {props.projects.map((project) => (
                <option value={project.path} key={project.path}>
                  {projectName(project)}
                </option>
              ))}
            </select>
          </label>
          <button className="inbox-toolbar__add" type="button" onClick={props.onAddProject}>
            <FolderPlus size={13} aria-hidden />
            <span>Add Project</span>
          </button>
        </div>
        {props.onOpenPullRequests ? (
          <button
            type="button"
            className={`inbox-toolbar__pulls${props.pullRequestsActive ? ' is-active' : ''}`}
            aria-current={props.pullRequestsActive ? 'page' : undefined}
            onClick={props.onOpenPullRequests}
          >
            <GitPullRequest size={14} aria-hidden />
            <span>Pull requests</span>
          </button>
        ) : null}
      </div>

      <div className="rail__body inbox__body">
        <div className="inbox">
          {selectedIds.size > 1 ? (
            <p className="inbox__selection-count">{selectedIds.size} threads selected</p>
          ) : null}

          {!normalizedQuery || active.length > 0 ? (
            <>
              <SectionHeading title="Active" count={active.length} />
              {active.length > 0 ? (
                <ul className="inbox__list" aria-label="Active threads">
                  {active.map((entry) => (
                    <ActiveRow
                      {...entry}
                      key={entry.session.id}
                      now={now}
                      current={entry.session.id === props.activeSessionId}
                      selected={selectedIds.has(entry.session.id)}
                      menuEntries={menuEntries(entry)}
                      actions={props.actions}
                      onChoose={(event) => chooseEntry(event, entry.session.id)}
                      onContextMenu={() => prepareContextMenu(entry.session.id)}
                      onRegister={(node) => registerRow(entry.session.id, node)}
                      onNavigate={(direction) => focusResult(entry.session.id, direction)}
                      onRename={(title) => props.onRenameSession(entry.session.id, title)}
                      onTogglePin={() => props.onToggleSessionPin?.(entry.session.id)}
                      onArchive={(id = entry.session.id) => props.onArchiveSession(id)}
                      onArchiveMany={(ids) => {
                        if (props.onArchiveSessions) props.onArchiveSessions(ids)
                        else ids.forEach(props.onArchiveSession)
                      }}
                      onClearSelection={clearSelection}
                    />
                  ))}
                </ul>
              ) : (
                <p className="inbox__empty">No active threads in this project.</p>
              )}
            </>
          ) : null}

          <Shelf
            title="Snoozed"
            count={snoozed.length}
            open={Boolean(normalizedQuery) || snoozedOpen || selectedSnoozed !== undefined}
            onToggle={() => setSnoozedOpen((open) => !open)}
          >
            {snoozed.map((entry) => (
              <ShelfRow
                {...entry}
                key={entry.session.id}
                now={now}
                current={entry.session.id === props.activeSessionId}
                selected={selectedIds.has(entry.session.id)}
                menuEntries={menuEntries(entry)}
                detail={formatWakeTime(wakeAt(entry.session), now)}
                action="Wake now"
                icon={<Bell size={13} aria-hidden />}
                actions={props.actions}
                onChoose={(event) => chooseEntry(event, entry.session.id)}
                onContextMenu={() => prepareContextMenu(entry.session.id)}
                onRegister={(node) => registerRow(entry.session.id, node)}
                onNavigate={(direction) => focusResult(entry.session.id, direction)}
                onRename={(title) => props.onRenameSession(entry.session.id, title)}
                onTogglePin={() => props.onToggleSessionPin?.(entry.session.id)}
                onArchive={(id = entry.session.id) => props.onArchiveSession(id)}
                onArchiveMany={(ids) => {
                  if (props.onArchiveSessions) props.onArchiveSessions(ids)
                  else ids.forEach(props.onArchiveSession)
                }}
                onAction={() => props.actions.onUnsnooze(entry.session.id)}
                onClearSelection={clearSelection}
              />
            ))}
          </Shelf>

          <Shelf
            title="Settled"
            count={settled.length}
            open={Boolean(normalizedQuery) || settledOpen || selectedSettled !== undefined}
            onToggle={() => setSettledOpen((open) => !open)}
          >
            {visibleSettled.map((entry) => (
              <ShelfRow
                {...entry}
                key={entry.session.id}
                now={now}
                current={entry.session.id === props.activeSessionId}
                selected={selectedIds.has(entry.session.id)}
                menuEntries={menuEntries(entry)}
                detail={`${projectName(entry.project)} · ${relativeTime(settledAt(entry.session), now)}`}
                action="Un-settle"
                icon={<CheckCheck size={13} aria-hidden />}
                actions={props.actions}
                onChoose={(event) => chooseEntry(event, entry.session.id)}
                onContextMenu={() => prepareContextMenu(entry.session.id)}
                onRegister={(node) => registerRow(entry.session.id, node)}
                onNavigate={(direction) => focusResult(entry.session.id, direction)}
                onRename={(title) => props.onRenameSession(entry.session.id, title)}
                onTogglePin={() => props.onToggleSessionPin?.(entry.session.id)}
                onArchive={(id = entry.session.id) => props.onArchiveSession(id)}
                onArchiveMany={(ids) => {
                  if (props.onArchiveSessions) props.onArchiveSessions(ids)
                  else ids.forEach(props.onArchiveSession)
                }}
                onAction={() => props.actions.onUnsettle(entry.session.id)}
                onClearSelection={clearSelection}
              />
            ))}
            {!normalizedQuery && settled.length > settledLimit ? (
              <li>
                <button
                  className="inbox__more"
                  type="button"
                  onClick={() => setSettledLimit((limit) => limit + 25)}
                >
                  Show 25 more
                </button>
              </li>
            ) : null}
          </Shelf>

          {normalizedQuery && !hasMatches ? (
            <p className="inbox__empty inbox__empty--search">No threads match “{query.trim()}”.</p>
          ) : null}
        </div>
      </div>
    </>
  )
}

function SectionHeading(props: { title: string; count: number }) {
  return (
    <p className="inbox__heading">
      <span>{props.title}</span>
      <span>{props.count}</span>
    </p>
  )
}

function ActiveRow(
  props: Entry & {
    now: number
    current: boolean
    selected: boolean
    menuEntries: Entry[]
    actions: InboxActions
    onChoose: (event: ReactMouseEvent) => void
    onContextMenu: () => void
    onRegister: (node: HTMLButtonElement | null) => void
    onNavigate: (direction: -1 | 1) => void
    onRename: (title: string) => void
    onTogglePin: () => void
    onArchive: (id?: string) => void
    onArchiveMany: (ids: string[]) => void
    onClearSelection: () => void
  },
) {
  const [renaming, setRenaming] = useState(false)
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const lifecycle =
    props.session.lifecycle.state === 'active'
      ? props.session.lifecycle
      : { state: 'active' as const, keepActive: false }
  const eligible = canHide(props.session)

  if (renaming) {
    return (
      <li className="inbox-card is-renaming">
        <Rename
          value={props.session.title}
          onCancel={() => setRenaming(false)}
          onCommit={(title) => {
            props.onRename(title)
            setRenaming(false)
          }}
        />
      </li>
    )
  }

  const setTarget = (node: HTMLButtonElement | null) => {
    contextMenuTarget.current = node
    props.onRegister(node)
  }

  return (
    <li
      className={`inbox-card${props.current ? ' is-selected' : ''}${props.selected ? ' is-multi-selected' : ''}`}
    >
      <button
        ref={setTarget}
        className="inbox-card__main"
        type="button"
        onClick={props.onChoose}
        onContextMenu={props.onContextMenu}
        onDoubleClick={() => setRenaming(true)}
        onKeyDown={(event) => navigateRows(event, props.onNavigate)}
        aria-label={rowLabel(props.project, props.session, props.now)}
        title={threadSummary(props.project, props.session, props.now)}
      >
        <span className="inbox-card__topline">
          <span className="inbox-card__project">{projectName(props.project)}</span>
          <span className="inbox-card__state">
            <Status session={props.session} now={props.now} />
          </span>
        </span>
        <span className="inbox-card__title">{props.session.title}</span>
        <span className="inbox-card__meta">
          {props.session.worktreeBranch ? (
            <span className="inbox-card__branch">
              <GitBranch size={10} aria-hidden />
              {props.session.worktreeBranch}
            </span>
          ) : (
            <span>Default checkout</span>
          )}
          <span aria-hidden>·</span>
          <SourceIdentity presentation={sessionSource(props.session)} density="compact" />
          {props.session.pinned ? (
            <>
              <span aria-hidden>·</span>
              <span>Pinned</span>
            </>
          ) : null}
          {lifecycle.wokeAt && props.session.status !== 'idle' ? (
            <span className="inbox-card__woke">Woke</span>
          ) : null}
        </span>
      </button>

      <span className="inbox-card__quick">
        {eligible ? (
          <>
            <SnoozeMenu
              label={`Snooze ${props.session.title}`}
              onSnooze={(wakeAt) => props.actions.onSnooze(props.session.id, wakeAt)}
            />
            <button
              type="button"
              title="Settle"
              aria-label={`Settle ${props.session.title}`}
              onClick={() => props.actions.onSettle(props.session.id)}
            >
              <CheckCheck size={13} aria-hidden />
            </button>
          </>
        ) : null}
        <ThreadMenu
          entry={{ project: props.project, session: props.session }}
          entries={props.menuEntries}
          actions={props.actions}
          contextMenuTarget={contextMenuTarget}
          onRename={() => setRenaming(true)}
          onTogglePin={props.onTogglePin}
          onArchive={props.onArchive}
          onArchiveMany={props.onArchiveMany}
          onClearSelection={props.onClearSelection}
        />
      </span>
    </li>
  )
}

function Shelf(props: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  if (props.count === 0) return null
  return (
    <section className="inbox-shelf">
      <button
        className="inbox-shelf__toggle"
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <ChevronRight size={11} aria-hidden />
        <span>{props.title}</span>
        <span>{props.count}</span>
      </button>
      {props.open ? <ul className="inbox-shelf__list">{props.children}</ul> : null}
    </section>
  )
}

function ShelfRow(
  props: Entry & {
    now: number
    current: boolean
    selected: boolean
    menuEntries: Entry[]
    detail: string
    action: string
    icon: ReactNode
    actions: InboxActions
    onChoose: (event: ReactMouseEvent) => void
    onContextMenu: () => void
    onRegister: (node: HTMLButtonElement | null) => void
    onNavigate: (direction: -1 | 1) => void
    onRename: (title: string) => void
    onTogglePin: () => void
    onArchive: (id?: string) => void
    onArchiveMany: (ids: string[]) => void
    onAction: () => void
    onClearSelection: () => void
  },
) {
  const [renaming, setRenaming] = useState(false)
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const setTarget = (node: HTMLButtonElement | null) => {
    contextMenuTarget.current = node
    props.onRegister(node)
  }

  return (
    <li
      className={`inbox-shelf__row${props.current ? ' is-selected' : ''}${props.selected ? ' is-multi-selected' : ''}`}
    >
      {renaming ? (
        <Rename
          value={props.session.title}
          onCancel={() => setRenaming(false)}
          onCommit={(title) => {
            props.onRename(title)
            setRenaming(false)
          }}
        />
      ) : (
        <button
          ref={setTarget}
          className="inbox-shelf__main"
          type="button"
          onClick={props.onChoose}
          onContextMenu={props.onContextMenu}
          onDoubleClick={() => setRenaming(true)}
          onKeyDown={(event) => navigateRows(event, props.onNavigate)}
          title={threadSummary(props.project, props.session, props.now)}
        >
          <span>{props.session.title}</span>
          <small>{props.detail}</small>
        </button>
      )}
      <button
        className="inbox-shelf__action"
        type="button"
        aria-label={`${props.action} ${props.session.title}`}
        onClick={props.onAction}
      >
        {props.icon}
      </button>
      {!renaming ? (
        <ThreadMenu
          entry={{ project: props.project, session: props.session }}
          entries={props.menuEntries}
          actions={props.actions}
          contextMenuTarget={contextMenuTarget}
          onRename={() => setRenaming(true)}
          onTogglePin={props.onTogglePin}
          onArchive={props.onArchive}
          onArchiveMany={props.onArchiveMany}
          onClearSelection={props.onClearSelection}
        />
      ) : null}
    </li>
  )
}

function ThreadMenu(props: {
  entry: Entry
  entries: Entry[]
  actions: InboxActions
  contextMenuTarget: RefObject<HTMLButtonElement | null>
  onRename: () => void
  onTogglePin: () => void
  onArchive: (id?: string) => void
  onArchiveMany: (ids: string[]) => void
  onClearSelection: () => void
}) {
  const multiple = props.entries.length > 1
  const active = props.entries.filter(
    (entry) => entry.session.lifecycle.state === 'active' && canHide(entry.session),
  )
  const snoozed = props.entries.filter((entry) => entry.session.lifecycle.state === 'snoozed')
  const settled = props.entries.filter((entry) => entry.session.lifecycle.state === 'settled')
  const lifecycle =
    props.entry.session.lifecycle.state === 'active' ? props.entry.session.lifecycle : undefined

  const finish = (close: () => void, action: () => void) => {
    action()
    props.onClearSelection()
    close()
  }

  return (
    <Menu
      drop="down"
      align="right"
      label={`Thread options for ${props.entry.session.title}`}
      triggerClassName="inbox-card__menu"
      panelClassName="menu--sidebar"
      contextMenuTargetRef={props.contextMenuTarget}
      trigger={() => <Ellipsis size={13} aria-hidden />}
    >
      {(close) => (
        <>
          {multiple ? (
            <div className="inbox-menu__selection">{props.entries.length} selected</div>
          ) : null}
          {active.length > 0 ? (
            <>
              <MenuItem
                title={multiple ? `Settle ${threadCount(active.length)}` : 'Settle'}
                icon={<CheckCheck size={13} aria-hidden />}
                onClick={() =>
                  finish(close, () => {
                    const ids = active.map((entry) => entry.session.id)
                    if (multiple && props.actions.onSettleMany) props.actions.onSettleMany(ids)
                    else ids.forEach((id) => props.actions.onSettle(id))
                  })
                }
              />
              {snoozePresets(Date.now()).map((preset) => (
                <MenuItem
                  key={preset.label}
                  title={
                    multiple ? `${preset.label} · ${threadCount(active.length)}` : preset.label
                  }
                  icon={<Clock3 size={13} aria-hidden />}
                  onClick={() =>
                    finish(close, () => {
                      const ids = active.map((entry) => entry.session.id)
                      if (multiple && props.actions.onSnoozeMany) {
                        props.actions.onSnoozeMany(ids, preset.at)
                      } else {
                        ids.forEach((id) => props.actions.onSnooze(id, preset.at))
                      }
                    })
                  }
                />
              ))}
            </>
          ) : null}
          {snoozed.length > 0 ? (
            <MenuItem
              title={multiple ? `Wake ${threadCount(snoozed.length)}` : 'Wake now'}
              icon={<Bell size={13} aria-hidden />}
              onClick={() =>
                finish(close, () => {
                  const ids = snoozed.map((entry) => entry.session.id)
                  if (multiple && props.actions.onUnsnoozeMany) props.actions.onUnsnoozeMany(ids)
                  else ids.forEach((id) => props.actions.onUnsnooze(id))
                })
              }
            />
          ) : null}
          {settled.length > 0 ? (
            <MenuItem
              title={multiple ? `Un-settle ${threadCount(settled.length)}` : 'Un-settle'}
              icon={<CheckCheck size={13} aria-hidden />}
              onClick={() =>
                finish(close, () => {
                  const ids = settled.map((entry) => entry.session.id)
                  if (multiple && props.actions.onUnsettleMany) props.actions.onUnsettleMany(ids)
                  else ids.forEach((id) => props.actions.onUnsettle(id))
                })
              }
            />
          ) : null}
          {!multiple ? (
            <>
              {lifecycle && canHide(props.entry.session) ? (
                <MenuItem
                  title={lifecycle.keepActive ? 'Allow auto-settle' : 'Keep active'}
                  onClick={() =>
                    finish(close, () =>
                      props.actions.onKeepActive(props.entry.session.id, !lifecycle.keepActive),
                    )
                  }
                />
              ) : null}
              <div className="menu__rule" />
              <MenuItem title="Rename" onClick={() => finish(close, props.onRename)} />
              <MenuItem
                title={props.entry.session.pinned ? 'Unpin thread' : 'Pin thread'}
                icon={
                  props.entry.session.pinned ? (
                    <PinOff size={13} aria-hidden />
                  ) : (
                    <Pin size={13} aria-hidden />
                  )
                }
                onClick={() => finish(close, props.onTogglePin)}
              />
              <MenuItem
                title="Copy project path"
                icon={<Copy size={13} aria-hidden />}
                onClick={() => finish(close, () => void copyText(props.entry.project.path))}
              />
              {props.entry.session.worktreeBranch ? (
                <MenuItem
                  title="Copy branch"
                  icon={<GitBranch size={13} aria-hidden />}
                  onClick={() =>
                    finish(close, () => void copyText(props.entry.session.worktreeBranch ?? ''))
                  }
                />
              ) : null}
            </>
          ) : null}
          <div className="menu__rule" />
          <MenuItem
            title={multiple ? `Delete ${props.entries.length} threads` : 'Delete thread'}
            icon={<Trash2 size={13} aria-hidden />}
            className="menu__item--danger"
            onClick={() =>
              finish(close, () => {
                if (multiple) {
                  props.onArchiveMany(props.entries.map((entry) => entry.session.id))
                } else {
                  props.onArchive()
                }
              })
            }
          />
        </>
      )}
    </Menu>
  )
}

function SnoozeMenu(props: { label: string; onSnooze: (wakeAt: number) => void }) {
  return (
    <Menu
      drop="down"
      align="right"
      label={props.label}
      panelClassName="menu--sidebar"
      trigger={() => <Clock3 size={13} aria-hidden />}
    >
      {(close) => (
        <>
          {snoozePresets(Date.now()).map((preset) => (
            <MenuItem
              key={preset.label}
              title={preset.label}
              onClick={() => {
                props.onSnooze(preset.at)
                close()
              }}
            />
          ))}
        </>
      )}
    </Menu>
  )
}

function Rename(props: { value: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const commit = () => {
    const next = value.trim()
    if (next) props.onCommit(next)
    else props.onCancel()
  }
  return (
    <input
      ref={ref}
      className="rename"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') props.onCancel()
      }}
    />
  )
}

function Status(props: { session: Session; now: number }) {
  const status = statusPresentation(props.session, props.now)
  return <span className={`inbox-status is-${status.tone}`}>{status.label}</span>
}

function statusPresentation(
  session: Session,
  now: number,
): { label: string; tone: 'quiet' | 'working' | 'attention' | 'failed' | 'done' | 'woke' } {
  const woke = session.lifecycle.state === 'active' && session.lifecycle.wokeAt !== undefined
  if (session.status === 'approval') return { label: 'Approval', tone: 'attention' }
  if (session.status === 'input') return { label: 'Needs input', tone: 'attention' }
  if (session.status === 'failed') return { label: 'Failed', tone: 'failed' }
  if (session.status === 'ready') return { label: 'Done', tone: 'done' }
  if (session.status === 'queued') return { label: 'Queued', tone: 'attention' }
  if (session.status === 'starting' || session.status === 'working') {
    return {
      label: `Working · ${elapsedTime(session.statusSince ?? session.createdAt, now)}`,
      tone: 'working',
    }
  }
  if (woke) return { label: 'Woke', tone: 'woke' }
  return { label: relativeTime(session.statusSince ?? session.createdAt, now), tone: 'quiet' }
}

function canHide(session: Session): boolean {
  return !['starting', 'working', 'queued', 'approval', 'input'].includes(session.status)
}

function threadCount(count: number): string {
  return `${count} ${count === 1 ? 'thread' : 'threads'}`
}

function navigateRows(
  event: KeyboardEvent<HTMLButtonElement>,
  navigate: (direction: -1 | 1) => void,
) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  navigate(event.key === 'ArrowDown' ? 1 : -1)
}

function newestFirst(a: Entry, b: Entry): number {
  return b.session.createdAt - a.session.createdAt
}

function withSelected(entries: Entry[], selected: Entry | undefined): Entry[] {
  return selected && !entries.some((entry) => entry.session.id === selected.session.id)
    ? [...entries, selected]
    : entries
}

function wakeAt(session: Session): number {
  return session.lifecycle.state === 'snoozed' ? session.lifecycle.wakeAt : 0
}

function settledAt(session: Session): number {
  return session.lifecycle.state === 'settled' ? session.lifecycle.settledAt : 0
}

function snoozePresets(now: number): Array<{ label: string; at: number }> {
  return [
    { label: 'In one hour', at: now + 60 * 60 * 1_000 },
    { label: 'This evening', at: thisEvening(now) },
    { label: 'Tomorrow morning', at: tomorrowMorning(now) },
    { label: 'Next week', at: nextWeek(now) },
  ]
}

function thisEvening(now: number): number {
  const next = new Date(now)
  next.setHours(18, 0, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function tomorrowMorning(now: number): number {
  const next = new Date(now)
  next.setDate(next.getDate() + 1)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

function nextWeek(now: number): number {
  const next = new Date(now)
  const daysUntilMonday = (8 - next.getDay()) % 7 || 7
  next.setDate(next.getDate() + daysUntilMonday)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

function formatWakeTime(at: number, now: number): string {
  const target = new Date(at)
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const time = target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay(target, today)) return `Today · ${time}`
  if (sameDay(target, tomorrow)) return `Tomorrow · ${time}`
  return target.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function elapsedTime(from: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function sessionSource(session: Session): ProviderPresentation {
  if (session.provider === 'acp' && session.agent) {
    return agentPresentation(session.agent)
  }
  return providerPresentation(session.provider)
}

function providerName(session: Session): string {
  return sessionSource(session).label
}

function projectName(project: Project): string {
  return project.name ?? project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path
}

function rowLabel(project: Project, session: Session, now: number): string {
  return `${session.title}, ${projectName(project)}, ${statusPresentation(session, now).label}`
}

function threadSummary(project: Project, session: Session, now: number): string {
  const lifecycle =
    session.lifecycle.state === 'active'
      ? 'Active'
      : session.lifecycle.state === 'snoozed'
        ? `Snoozed until ${formatWakeTime(session.lifecycle.wakeAt, now)}`
        : `Settled ${relativeTime(session.lifecycle.settledAt, now)}`
  return [
    session.title,
    `Project: ${projectName(project)}`,
    `Environment: ${project.path}`,
    `Branch: ${session.worktreeBranch ?? 'default checkout'}`,
    `Provider: ${providerName(session)}`,
    `Status: ${statusPresentation(session, now).label}`,
    `Lifecycle: ${lifecycle}`,
    `Created: ${new Date(session.createdAt).toLocaleString()}`,
  ].join('\n')
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value)
  } catch {
    // Clipboard permission errors leave the menu action as a no-op.
  }
}
