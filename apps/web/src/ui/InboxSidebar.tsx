import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, CheckCheck, ChevronRight, Ellipsis, Plus } from 'lucide-react'
import { Menu, MenuItem } from './Menu.js'
import type { Project, Session } from './Sidebar.js'

type Entry = { project: Project; session: Session }

export type InboxActions = {
  onSettle: (id: string) => void
  onUnsettle: (id: string) => void
  onSnooze: (id: string, wakeAt: number) => void
  onUnsnooze: (id: string) => void
  onKeepActive: (id: string, keepActive: boolean) => void
}

export function InboxSidebar(props: {
  projects: Project[]
  scope: string
  activeSessionId: string | undefined
  actions: InboxActions
  onScopeChange: (path: string) => void
  onNewSession: (path: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onArchiveSession: (id: string) => void
}) {
  const [snoozedOpen, setSnoozedOpen] = useState(false)
  const [settledOpen, setSettledOpen] = useState(false)
  const [settledLimit, setSettledLimit] = useState(10)
  const entries = props.projects
    .flatMap((project) => project.sessions.map((session) => ({ project, session })))
    .filter((entry) => !props.scope || entry.project.path === props.scope)
  const active = entries
    .filter((entry) => entry.session.lifecycle.state === 'active')
    .sort(newestFirst)
  const snoozed = entries
    .filter((entry) => entry.session.lifecycle.state === 'snoozed')
    .sort((a, b) => wakeAt(a.session) - wakeAt(b.session))
  const settled = entries
    .filter((entry) => entry.session.lifecycle.state === 'settled')
    .sort((a, b) => settledAt(b.session) - settledAt(a.session))
  const selectedSnoozed = snoozed.find((entry) => entry.session.id === props.activeSessionId)
  const selectedSettled = settled.find((entry) => entry.session.id === props.activeSessionId)
  const visibleSettled = withSelected(settled.slice(0, settledLimit), selectedSettled)

  useEffect(() => setSettledLimit(10), [props.scope])

  return (
    <div className="inbox">
      <label className="inbox__scope">
        <span>Scope</span>
        <select
          aria-label="Sidebar project scope"
          value={props.scope}
          onChange={(event) => props.onScopeChange(event.target.value)}
        >
          <option value="">All projects</option>
          {props.projects.map((project) => (
            <option value={project.path} key={project.path}>
              {projectName(project)}
            </option>
          ))}
        </select>
      </label>

      <p className="inbox__heading">Active</p>
      {active.length > 0 ? (
        <ul className="inbox__list" aria-label="Active chats">
          {active.map((entry) => (
            <ActiveRow
              {...entry}
              key={entry.session.id}
              selected={entry.session.id === props.activeSessionId}
              actions={props.actions}
              onSelect={() => props.onSelectSession(entry.session.id)}
              onRename={(title) => props.onRenameSession(entry.session.id, title)}
              onArchive={() => props.onArchiveSession(entry.session.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="inbox__empty">No active chats in this scope.</p>
      )}

      <ProjectManager {...props} />

      <Shelf
        title="Snoozed"
        count={snoozed.length}
        open={snoozedOpen || selectedSnoozed !== undefined}
        onToggle={() => setSnoozedOpen((open) => !open)}
      >
        {snoozed.map((entry) => (
          <ShelfRow
            {...entry}
            key={entry.session.id}
            selected={entry.session.id === props.activeSessionId}
            detail={`Wakes ${formatTime(wakeAt(entry.session))}`}
            action="Wake now"
            icon={<Bell size={13} aria-hidden />}
            onSelect={() => props.onSelectSession(entry.session.id)}
            onAction={() => props.actions.onUnsnooze(entry.session.id)}
          />
        ))}
      </Shelf>

      <Shelf
        title="Settled"
        count={settled.length}
        open={settledOpen || selectedSettled !== undefined}
        onToggle={() => setSettledOpen((open) => !open)}
      >
        {visibleSettled.map((entry) => (
          <ShelfRow
            {...entry}
            key={entry.session.id}
            selected={entry.session.id === props.activeSessionId}
            detail={`${projectName(entry.project)} · ${relativeTime(settledAt(entry.session))}`}
            action="Unsettle"
            icon={<CheckCheck size={13} aria-hidden />}
            onSelect={() => props.onSelectSession(entry.session.id)}
            onAction={() => props.actions.onUnsettle(entry.session.id)}
          />
        ))}
        {settled.length > settledLimit ? (
          <button
            className="inbox__more"
            type="button"
            onClick={() => setSettledLimit((limit) => limit + 25)}
          >
            Load 25 more
          </button>
        ) : null}
      </Shelf>
    </div>
  )
}

function ActiveRow(
  props: Entry & {
    selected: boolean
    actions: InboxActions
    onSelect: () => void
    onRename: (title: string) => void
    onArchive: () => void
  },
) {
  const [renaming, setRenaming] = useState(false)
  const lifecycle =
    props.session.lifecycle.state === 'active'
      ? props.session.lifecycle
      : { state: 'active' as const, keepActive: false }
  const eligible = !['starting', 'working', 'queued', 'approval', 'input'].includes(
    props.session.status,
  )

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

  return (
    <li className={`inbox-card${props.selected ? ' is-selected' : ''}`}>
      <button
        className="inbox-card__main"
        type="button"
        onClick={props.onSelect}
        onDoubleClick={() => setRenaming(true)}
        aria-label={rowLabel(props.project, props.session)}
      >
        <span className="inbox-card__topline">
          <span className="inbox-card__title">{props.session.title}</span>
          <Status status={props.session.status} />
        </span>
        <span className="inbox-card__meta">
          <span>{projectName(props.project)}</span>
          <span aria-hidden>·</span>
          <span>{providerName(props.session)}</span>
          <span aria-hidden>·</span>
          <span>{props.session.worktreeBranch ?? relativeTime(props.session.createdAt)}</span>
          {props.session.lifecycle.state === 'active' && props.session.lifecycle.wokeAt ? (
            <span className="inbox-card__woke">Woke</span>
          ) : null}
        </span>
      </button>
      <span className="inbox-card__actions">
        {eligible ? (
          <button
            className="inbox-card__settle"
            type="button"
            title="Settle"
            aria-label={`Settle ${props.session.title}`}
            onClick={() => props.actions.onSettle(props.session.id)}
          >
            <CheckCheck size={14} aria-hidden />
          </button>
        ) : null}
        <Menu
          drop="down"
          align="right"
          label={`Chat options for ${props.session.title}`}
          trigger={() => <Ellipsis size={14} aria-hidden />}
        >
          {(close) => (
            <>
              {eligible ? (
                <>
                  <MenuItem
                    title="Snooze for 1 hour"
                    onClick={() => {
                      props.actions.onSnooze(props.session.id, Date.now() + 60 * 60 * 1_000)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Snooze until tomorrow"
                    onClick={() => {
                      props.actions.onSnooze(props.session.id, tomorrowMorning())
                      close()
                    }}
                  />
                  <MenuItem
                    title="Snooze for 1 week"
                    onClick={() => {
                      props.actions.onSnooze(
                        props.session.id,
                        Date.now() + 7 * 24 * 60 * 60 * 1_000,
                      )
                      close()
                    }}
                  />
                  <MenuItem
                    title={lifecycle.keepActive ? 'Allow auto-settle' : 'Keep active'}
                    onClick={() => {
                      props.actions.onKeepActive(props.session.id, !lifecycle.keepActive)
                      close()
                    }}
                  />
                  <div className="menu__rule" />
                </>
              ) : null}
              <MenuItem
                title="Rename"
                onClick={() => {
                  setRenaming(true)
                  close()
                }}
              />
              <MenuItem
                title="Archive"
                detail="Separate from settling"
                onClick={() => {
                  props.onArchive()
                  close()
                }}
              />
            </>
          )}
        </Menu>
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
    selected: boolean
    detail: string
    action: string
    icon: ReactNode
    onSelect: () => void
    onAction: () => void
  },
) {
  return (
    <li className={`inbox-shelf__row${props.selected ? ' is-selected' : ''}`}>
      <button type="button" onClick={props.onSelect}>
        <span>{props.session.title}</span>
        <small>{props.detail}</small>
      </button>
      <button
        type="button"
        aria-label={`${props.action} ${props.session.title}`}
        onClick={props.onAction}
      >
        {props.icon}
      </button>
    </li>
  )
}

function ProjectManager(props: {
  projects: Project[]
  onNewSession: (path: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
}) {
  const [renaming, setRenaming] = useState<string>()
  return (
    <details className="inbox-projects">
      <summary>Projects · {props.projects.length}</summary>
      <ul>
        {props.projects.map((project) => (
          <li key={project.path}>
            {renaming === project.path ? (
              <Rename
                value={projectName(project)}
                onCancel={() => setRenaming(undefined)}
                onCommit={(name) => {
                  props.onRenameProject(project.path, name)
                  setRenaming(undefined)
                }}
              />
            ) : (
              <>
                <span title={project.path}>{projectName(project)}</span>
                <button
                  type="button"
                  aria-label={`New chat in ${projectName(project)}`}
                  onClick={() => props.onNewSession(project.path)}
                >
                  <Plus size={13} aria-hidden />
                </button>
                <Menu
                  drop="down"
                  align="right"
                  label={`Project options for ${projectName(project)}`}
                  trigger={() => <Ellipsis size={13} aria-hidden />}
                >
                  {(close) => (
                    <>
                      <MenuItem
                        title="Rename"
                        onClick={() => {
                          setRenaming(project.path)
                          close()
                        }}
                      />
                      <MenuItem
                        title={project.pinned ? 'Unpin' : 'Pin to top'}
                        onClick={() => {
                          props.onTogglePin(project.path)
                          close()
                        }}
                      />
                      <MenuItem
                        title="Remove from sidebar"
                        detail="The folder on disk is untouched"
                        onClick={() => {
                          props.onRemoveProject(project.path)
                          close()
                        }}
                      />
                    </>
                  )}
                </Menu>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
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
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') props.onCancel()
      }}
    />
  )
}

function Status(props: { status: Session['status'] }) {
  return <span className={`inbox-status is-${props.status}`}>{statusLabel(props.status)}</span>
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

function tomorrowMorning(): number {
  const next = new Date()
  next.setDate(next.getDate() + 1)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function statusLabel(status: Session['status']): string {
  return {
    starting: 'Starting',
    working: 'Working',
    queued: 'Queued',
    approval: 'Approval',
    input: 'Input',
    failed: 'Failed',
    ready: 'Ready',
    idle: 'Idle',
  }[status]
}

function providerName(session: Session): string {
  if (session.provider === 'claude-code') return 'Claude Code'
  if (session.provider === 'acp') return session.agent ?? 'ACP'
  return session.provider === 'codex' ? 'Codex' : session.provider
}

function projectName(project: Project): string {
  return project.name ?? project.path.split(/[\\/]/).filter(Boolean).at(-1) ?? project.path
}

function rowLabel(project: Project, session: Session): string {
  return `${session.title}, ${projectName(project)}, ${statusLabel(session.status)}`
}
