import {
  memo,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  Account,
  ProviderId,
  ResultOf,
  ThreadInboxStatus,
  ThreadLifecycle,
} from '@harness/contracts'
import {
  Archive,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPen,
  Gauge,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { isDesktop, isMacOS, revealPath } from '../bridge.js'
import { SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'
import { Menu, MenuItem } from './Menu.js'
import { ShortcutHint } from './ShortcutHint.js'
import { InboxSidebar, type InboxActions } from './InboxSidebar.js'

/**
 * The rail. Collapsible, searchable, and everything in it can be renamed.
 *
 * Nothing wraps: titles are arbitrary user text and a list whose rows change
 * height as titles grow is visually unstable.
 */

export type Session = {
  id: string
  title: string
  provider: ProviderId
  agent?: string | undefined
  createdAt: number
  status: ThreadInboxStatus
  lifecycle: ThreadLifecycle
  unread: boolean
  pinned?: boolean
  worktreeBranch?: string | undefined
}

export type Project = {
  path: string
  /** User-chosen name. Falls back to the folder name. */
  name?: string
  sessions: Session[]
  pinned?: boolean
}

type DropPosition = 'before' | 'after'

const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const MIN_RAIL_WIDTH = 148
const COLLAPSE_RAIL_WIDTH = 176
const MAX_RAIL_WIDTH = 420
const COLLAPSED_PROJECT_SESSION_COUNT = 5

function SidebarComponent(props: {
  projects: Project[]
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  account: Account | undefined
  providerName: string
  usageSummary?: ResultOf<'usage.summary'> | undefined
  hasActiveUsageSession?: boolean | undefined
  usageSources?: string[] | undefined
  mode?: 'classic' | 'inbox'
  onModeChange?: ((mode: 'classic' | 'inbox') => void) | undefined
  inbox?: InboxActions | undefined
  collapsed: boolean
  width: number
  onClose: () => void
  onWidthChange: (width: number) => void
  onAddProject: () => void
  onNewSession: (projectPath?: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  onDeleteSession: (id: string) => void
  onArchiveProject: (sessionIds: string[]) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
  onOpenSearch: (projectPath?: string) => void
  onOpenSettings: () => void
}) {
  const [edgeRevealed, setEdgeRevealed] = useState(false)
  const [scope, setScope] = useState('')
  const macOS = isMacOS()
  const inbox = props.mode === 'inbox' && props.inbox !== undefined

  useEffect(() => {
    if (!props.collapsed) setEdgeRevealed(false)
  }, [props.collapsed])

  useEffect(() => {
    if (scope && !props.projects.some((project) => project.path === scope)) setScope('')
  }, [props.projects, scope])

  // Memoised because the sidebar re-renders with every streamed frame: these
  // three passes over every project and session ran 60 times a second while
  // an answer arrived, for a list that had not changed.
  const pinnedSessions = useMemo(
    () =>
      props.projects.flatMap((project) =>
        project.sessions
          .filter((session) => session.pinned)
          .map((session) => ({ projectPath: project.path, session })),
      ),
    [props.projects],
  )
  const orderedProjects = useMemo(
    () =>
      [
        ...props.projects.filter((project) => project.pinned),
        ...props.projects.filter((project) => !project.pinned),
      ].map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !session.pinned),
      })),
    [props.projects],
  )

  return (
    <div
      className={`rail-slot ${props.collapsed ? 'is-collapsed' : ''} ${
        edgeRevealed ? 'is-revealed' : ''
      }`}
      onMouseLeave={() => setEdgeRevealed(false)}
    >
      {props.collapsed ? (
        <div className="rail__edge" aria-hidden onMouseEnter={() => setEdgeRevealed(true)} />
      ) : null}

      {!props.collapsed ? (
        <button
          type="button"
          className="rail__backdrop"
          aria-label="Close sidebar"
          tabIndex={-1}
          onPointerDown={props.onClose}
        />
      ) : null}

      <nav className="rail" inert={props.collapsed && !edgeRevealed ? true : undefined}>
        <div className="rail__actions">
          <button
            className="navitem"
            aria-keyshortcuts={shortcutAria(SHORTCUTS.newChat)}
            onClick={() => {
              if (inbox) {
                props.onNewSession(
                  scope || (props.projects.length === 1 ? props.projects[0]?.path : undefined),
                )
                return
              }
              const project =
                props.projects.find((candidate) => candidate.path === props.activeProjectPath) ??
                props.projects[0]
              if (project) props.onNewSession(project.path)
              else props.onAddProject()
            }}
          >
            <Plus size={15} aria-hidden />
            <span>New chat</span>
            <ShortcutHint>{shortcutLabel(SHORTCUTS.newChat, macOS)}</ShortcutHint>
          </button>
          <button
            className="navitem rail__new-project"
            onClick={props.onAddProject}
            aria-keyshortcuts={shortcutAria(SHORTCUTS.newProject)}
          >
            <FolderPen size={15} aria-hidden />
            <span>New project</span>
            <ShortcutHint>{shortcutLabel(SHORTCUTS.newProject, macOS)}</ShortcutHint>
          </button>
          <div className="rail__utility-row">
            <button
              type="button"
              className="icon-btn icon-btn--always rail__search"
              onClick={() => props.onOpenSearch(inbox && scope ? scope : undefined)}
              aria-label="Search chats"
              title={`Search chats (${shortcutLabel(SHORTCUTS.searchSessions, macOS)})`}
              aria-keyshortcuts={shortcutAria(SHORTCUTS.searchSessions)}
            >
              <Search size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="rail__mode-toggle"
              aria-pressed={inbox}
              aria-label={`Switch to ${inbox ? 'V1 Classic' : 'V2 Inbox'} sidebar`}
              title={`Switch to ${inbox ? 'V1 Classic' : 'V2 Inbox'} sidebar`}
              onClick={() => props.onModeChange?.(inbox ? 'classic' : 'inbox')}
            >
              V{inbox ? '2' : '1'}
            </button>
          </div>
        </div>

        <div className="rail__body">
          {inbox ? (
            <InboxSidebar
              projects={props.projects}
              scope={scope}
              activeSessionId={props.activeSessionId}
              actions={props.inbox!}
              onScopeChange={setScope}
              onNewSession={(path) => props.onNewSession(path)}
              onSelectSession={props.onSelectSession}
              onRenameProject={props.onRenameProject}
              onRemoveProject={props.onRemoveProject}
              onTogglePin={props.onTogglePin}
              onRenameSession={props.onRenameSession}
              onToggleSessionPin={(id) => props.onToggleSessionPin?.(id)}
              onArchiveSession={props.onDeleteSession}
            />
          ) : (
            <>
              {pinnedSessions.length > 0 ? (
                <>
                  <p className="section">Pinned</p>
                  <ul className="proj__sessions pinned-sessions">
                    {pinnedSessions.map(({ projectPath, session }) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === props.activeSessionId}
                        standalone
                        onSelect={() => props.onSelectSession(session.id)}
                        onRename={(title) => props.onRenameSession(session.id, title)}
                        onDelete={() => props.onDeleteSession(session.id)}
                        onTogglePin={() => props.onToggleSessionPin?.(session.id)}
                        onOpenInExplorer={() => void revealPath(projectPath)}
                        reorderable={false}
                        dragging={false}
                        dropPosition={undefined}
                        onDragStart={() => undefined}
                        onDragOver={() => undefined}
                        onDrop={() => undefined}
                        onDragEnd={() => undefined}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="section">Projects</p>
              {orderedProjects.length === 0 ? (
                <p className="rail__hint">Nothing here yet.</p>
              ) : (
                orderedProjects.map((project) => (
                  <ProjectRow key={project.path} project={project} {...props} forceOpen={false} />
                ))
              )}
            </>
          )}
        </div>

        <div className="rail__foot">
          <UsageLimits
            providerName={props.providerName}
            summary={props.usageSummary}
            showTotals={props.hasActiveUsageSession ?? Boolean(props.activeSessionId)}
            sources={props.usageSources ?? []}
          />
          <Menu
            drop="up"
            label="Account"
            panelClassName="menu--settings"
            trigger={() => (
              <span className="account">
                <span className="account__avatar">
                  {initial(props.account, props.providerName)}
                </span>
                <span className="account__name">{props.providerName}</span>
              </span>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  title="Settings"
                  shortcut={shortcutLabel(SHORTCUTS.settings, macOS)}
                  shortcutAria={shortcutAria(SHORTCUTS.settings)}
                  onClick={() => {
                    props.onOpenSettings()
                    close()
                  }}
                />
              </>
            )}
          </Menu>
        </div>
      </nav>
      {!props.collapsed ? (
        <RailResizeHandle
          width={props.width}
          onWidthChange={props.onWidthChange}
          onCollapse={props.onClose}
        />
      ) : null}
    </div>
  )
}

function UsageLimits(props: {
  providerName: string
  summary: ResultOf<'usage.summary'> | undefined
  showTotals: boolean
  sources: string[]
}) {
  const primary = props.summary?.limits[0]
  const otherSources = props.sources.filter((source) => source !== props.providerName)

  return (
    <Menu
      drop="up"
      align="left"
      label="Usage limits"
      panelRole="dialog"
      panelLabel="Provider usage limits"
      panelClassName="usage-limits__panel"
      triggerClassName="usage-limits__trigger"
      trigger={() => (
        <span className="usage-limits__summary">
          <Gauge size={14} aria-hidden />
          <span>{primary ? `${Math.round(100 - primary.usedPercent)}% left` : 'Limits'}</span>
        </span>
      )}
    >
      {() => (
        <div className="usage-limits">
          <div className="usage-limits__head">
            <strong>{props.providerName}</strong>
            <span>Provider-reported usage</span>
          </div>
          {props.summary && props.showTotals ? (
            <div className="usage-limits__totals">
              <span>{compactTokens(props.summary.session.totalTokens)} this chat</span>
              <span>{compactTokens(props.summary.today.totalTokens)} today</span>
            </div>
          ) : null}
          {props.summary?.limits.length ? (
            <div className="usage-limits__windows">
              {props.summary.limits.map((limit) => {
                const left = Math.round(100 - limit.usedPercent)
                return (
                  <div className="usage-limit" key={limit.label}>
                    <div className="usage-limit__label">
                      <span>{limit.label}</span>
                      <strong>{left}% left</strong>
                    </div>
                    <span className="usage-limit__track" aria-hidden>
                      <span style={{ width: `${left}%` }} />
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="usage-limits__empty">This provider does not report rate limits.</p>
          )}
          {otherSources.length > 0 ? (
            <div className="usage-limits__other">
              {otherSources.map((source) => (
                <div key={source}>
                  <span>{source}</span>
                  <span>Not reported</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Menu>
  )
}

function compactTokens(value: number): string {
  return value < 1_000 ? `${value} tokens` : `${Math.round(value / 100) / 10}k tokens`
}

function RailResizeHandle(props: {
  width: number
  onWidthChange: (width: number) => void
  onCollapse: () => void
}) {
  const drag = useRef<{ startX: number; width: number; current: number } | undefined>(undefined)

  const preview = (target: HTMLElement, width: number) => {
    target.closest<HTMLElement>('.shell')?.style.setProperty('--rail-w', `${width}px`)
  }

  const finish = (target: HTMLElement, width: number) => {
    if (width <= COLLAPSE_RAIL_WIDTH) {
      preview(target, props.width)
      props.onCollapse()
    } else {
      props.onWidthChange(width)
    }
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = clampRailWidth(props.width + (event.key === 'ArrowLeft' ? -8 : 8))
    finish(event.currentTarget, next)
  }

  return (
    <button
      type="button"
      className="rail__resize"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_RAIL_WIDTH}
      aria-valuemax={MAX_RAIL_WIDTH}
      aria-valuenow={props.width}
      onKeyDown={resizeWithKeyboard}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture?.(event.pointerId)
        drag.current = { startX: event.clientX, width: props.width, current: props.width }
      }}
      onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
        if (!drag.current) return
        const next = clampRailWidth(drag.current.width + event.clientX - drag.current.startX)
        drag.current.current = next
        preview(event.currentTarget, next)
      }}
      onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
        if (!drag.current) return
        const width = drag.current.current
        drag.current = undefined
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        finish(event.currentTarget, width)
      }}
    />
  )
}

function clampRailWidth(width: number): number {
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)))
}

function ProjectRow(props: {
  project: Project
  activeSessionId: string | undefined
  forceOpen: boolean
  onNewSession: (path: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onToggleSessionPin?: (id: string) => void
  onDeleteSession: (id: string) => void
  onArchiveProject: (sessionIds: string[]) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
}) {
  const [open, setOpen] = useState(true)
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'remove'>()
  const [draggedSessionId, setDraggedSessionId] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: DropPosition
  }>()
  const contextMenuTarget = useRef<HTMLButtonElement>(null)
  const expanded = open || props.forceOpen
  const count = props.project.sessions.length
  const hasMoreSessions = count > COLLAPSED_PROJECT_SESSION_COUNT
  const visibleSessions = showAllSessions
    ? props.project.sessions
    : props.project.sessions.slice(0, COLLAPSED_PROJECT_SESSION_COUNT)
  const reorderable = !props.forceOpen

  const endDrag = () => {
    setDraggedSessionId(undefined)
    setDropTarget(undefined)
  }

  const dragOverSession = (event: DragEvent<HTMLLIElement>, targetId: string) => {
    if (!draggedSessionId || draggedSessionId === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    setDropTarget({ id: targetId, position })
  }

  return (
    <section className="proj">
      <div className="proj__head">
        {renaming ? (
          <InlineRename
            value={displayName(props.project)}
            onCommit={(name) => {
              props.onRenameProject(props.project.path, name)
              setRenaming(false)
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <button
              ref={contextMenuTarget}
              className="proj__toggle"
              onClick={() => {
                if (expanded) setShowAllSessions(false)
                setOpen(!expanded)
              }}
              title={props.project.path}
            >
              <Folder className="proj__mark" size={12} aria-hidden />
              <span className="proj__name">{displayName(props.project)}</span>
            </button>

            <Menu
              drop="down"
              align="right"
              label="Project options"
              panelClassName="menu--sidebar"
              contextMenuTargetRef={contextMenuTarget}
              trigger={() => (
                <span className="dots">
                  <Ellipsis size={16} aria-hidden />
                </span>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    title={props.project.pinned ? 'Unpin' : 'Pin to top'}
                    icon={
                      props.project.pinned ? (
                        <PinOff size={14} aria-hidden />
                      ) : (
                        <Pin size={14} aria-hidden />
                      )
                    }
                    onClick={() => {
                      props.onTogglePin(props.project.path)
                      close()
                    }}
                  />
                  {isDesktop ? (
                    <MenuItem
                      title="Open in Explorer"
                      icon={<FolderOpen size={14} aria-hidden />}
                      onClick={() => {
                        void revealPath(props.project.path)
                        close()
                      }}
                    />
                  ) : null}
                  <MenuItem
                    title="Edit name"
                    icon={<Pencil size={14} aria-hidden />}
                    onClick={() => {
                      setRenaming(true)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Archive chats"
                    icon={<Archive size={14} aria-hidden />}
                    onClick={() => {
                      setConfirming('archive')
                      close()
                    }}
                  />
                  <MenuItem
                    title="Remove from sidebar"
                    icon={<PanelLeftClose size={14} aria-hidden />}
                    className="menu__item--danger"
                    onClick={() => {
                      setConfirming('remove')
                      close()
                    }}
                  />
                </>
              )}
            </Menu>

            <button
              className="icon-btn"
              onClick={() => props.onNewSession(props.project.path)}
              title="New chat here"
            >
              <Plus size={13} aria-hidden />
            </button>
          </>
        )}
      </div>

      {confirming ? (
        <SidebarConfirmDialog
          title={confirming === 'archive' ? 'Archive all chats?' : 'Remove project?'}
          body={
            confirming === 'archive'
              ? `This archives every chat in ${displayName(props.project)}. Files on your computer stay untouched.`
              : 'This only removes the project from the sidebar. Its folder and chats stay untouched.'
          }
          action={confirming === 'archive' ? 'Archive chats' : 'Remove project'}
          destructive={confirming === 'remove'}
          onConfirm={() => {
            if (confirming === 'archive') {
              props.onArchiveProject(props.project.sessions.map((session) => session.id))
            } else {
              props.onRemoveProject(props.project.path)
            }
            setConfirming(undefined)
          }}
          onClose={() => setConfirming(undefined)}
        />
      ) : null}

      {/* Height comes from grid-template-rows in CSS, so the animation covers
          the drawer's real height. The old per-row cap was double the actual
          row height, which spent half the duration moving nothing — the main
          reason the sidebar read as sluggish. */}
      <div className="proj__drawer" data-open={expanded && count > 0}>
        <ul className="proj__sessions">
          {visibleSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === props.activeSessionId}
              onSelect={() => props.onSelectSession(session.id)}
              onRename={(title) => props.onRenameSession(session.id, title)}
              onDelete={() => props.onDeleteSession(session.id)}
              onTogglePin={() => props.onToggleSessionPin?.(session.id)}
              onOpenInExplorer={() => void revealPath(props.project.path)}
              reorderable={reorderable}
              dragging={session.id === draggedSessionId}
              dropPosition={dropTarget?.id === session.id ? dropTarget.position : undefined}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', session.id)
                setDraggedSessionId(session.id)
              }}
              onDragOver={(event) => dragOverSession(event, session.id)}
              onDrop={(event) => {
                event.preventDefault()
                if (
                  draggedSessionId &&
                  dropTarget?.id === session.id &&
                  draggedSessionId !== session.id
                ) {
                  props.onReorderSession(
                    props.project.path,
                    draggedSessionId,
                    session.id,
                    dropTarget.position,
                  )
                }
                endDrag()
              }}
              onDragEnd={endDrag}
            />
          ))}
          {hasMoreSessions ? (
            <li className="proj__sessions-toggle-row">
              <button
                type="button"
                className="proj__sessions-toggle"
                aria-expanded={showAllSessions}
                onClick={() => setShowAllSessions((current) => !current)}
              >
                {showAllSessions ? 'Show less' : 'Show more'}
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </section>
  )
}

function SessionRow(props: {
  session: Session
  active: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onTogglePin: () => void
  onOpenInExplorer: () => void
  standalone?: boolean
  reorderable: boolean
  dragging: boolean
  dropPosition: DropPosition | undefined
  onDragStart: (event: DragEvent<HTMLLIElement>) => void
  onDragOver: (event: DragEvent<HTMLLIElement>) => void
  onDrop: (event: DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const contextMenuTarget = useRef<HTMLButtonElement>(null)

  if (renaming) {
    return (
      <li>
        <InlineRename
          value={props.session.title}
          onCommit={(title) => {
            props.onRename(title)
            setRenaming(false)
          }}
          onCancel={() => setRenaming(false)}
        />
      </li>
    )
  }

  return (
    <li
      className={`sessrow ${props.active ? 'is-active' : ''} ${props.standalone ? 'is-pinned' : ''} ${
        props.reorderable ? 'is-reorderable' : ''
      } ${props.dragging ? 'is-dragging' : ''}`}
      draggable={props.reorderable}
      data-drop-position={props.dropPosition}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      <button
        ref={contextMenuTarget}
        className={`sess ${props.active ? 'is-active' : ''}`}
        onClick={props.onSelect}
        onDoubleClick={() => setRenaming(true)}
        aria-label={sessionLabel(props.session)}
        title={sessionLabel(props.session)}
      >
        <span className="sess__title">{props.session.title}</span>
        <SessionStatus status={props.session.status} />
      </button>

      <span className="sess__actions">
        <button
          type="button"
          className="sess__action"
          onClick={() => setRenaming(true)}
          aria-label={`Rename ${props.session.title}`}
          title="Rename chat"
        >
          <Pencil size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="sess__action"
          onClick={props.onDelete}
          aria-label={`Archive ${props.session.title}`}
          title="Archive chat"
        >
          <Archive size={14} aria-hidden />
        </button>
      </span>

      <div className="sess__context-menu">
        <Menu
          drop="down"
          align="right"
          label={`Options for ${props.session.title}`}
          triggerClassName="sess__context-menu-trigger"
          panelClassName="menu--sidebar"
          contextMenuTargetRef={contextMenuTarget}
          trigger={() => <Ellipsis size={16} aria-hidden />}
        >
          {(close) => (
            <>
              <MenuItem
                title={props.session.pinned ? 'Unpin chat' : 'Pin chat'}
                onClick={() => {
                  props.onTogglePin()
                  close()
                }}
              />
              <MenuItem
                title="Rename chat"
                onClick={() => {
                  setRenaming(true)
                  close()
                }}
              />
              <MenuItem
                title="Archive chat"
                onClick={() => {
                  props.onDelete()
                  close()
                }}
              />
              {isDesktop ? (
                <MenuItem
                  title="Open in Explorer"
                  onClick={() => {
                    props.onOpenInExplorer()
                    close()
                  }}
                />
              ) : null}
            </>
          )}
        </Menu>
      </div>
    </li>
  )
}

function SidebarConfirmDialog(props: {
  title: string
  body: string
  action: string
  destructive: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Cancel" />
      <div className="sheet__panel sidebar-confirm">
        <header className="sheet__head">
          <h2 className="sheet__title">{props.title}</h2>
          <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
            <X size={13} aria-hidden />
          </button>
        </header>
        <section className="sheet__section">
          <p>{props.body}</p>
          <div className="sidebar-confirm__actions">
            <button className="ghost" onClick={props.onClose} autoFocus>
              Cancel
            </button>
            <button
              className={`btn${props.destructive ? ' btn--danger' : ''}`}
              onClick={props.onConfirm}
            >
              {props.action}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function SessionStatus(props: { status: Session['status'] }) {
  if (props.status === 'starting' || props.status === 'working') {
    return (
      <span className="sess__spinner" aria-hidden>
        {BRAILLE_SPINNER_FRAMES.map((frame) => (
          <span key={frame}>{frame}</span>
        ))}
      </span>
    )
  }

  if (props.status === 'approval' || props.status === 'input' || props.status === 'queued') {
    return <span className="sess__status-dot is-attention" aria-hidden />
  }

  if (props.status === 'failed') {
    return <span className="sess__status-dot is-failed" aria-hidden />
  }

  return null
}

function sessionLabel(session: Session): string {
  const branch = session.worktreeBranch ? `, isolated on ${session.worktreeBranch}` : ''
  switch (session.status) {
    case 'starting':
    case 'working':
      return `${session.title}, working${branch}`
    case 'queued':
      return `${session.title}, queued${branch}`
    case 'approval':
      return `${session.title}, waiting for approval${branch}`
    case 'input':
      return `${session.title}, needs attention${branch}`
    case 'failed':
      return `${session.title}, failed${branch}`
    case 'ready':
      return `${session.title}, ready${branch}`
    default:
      return `${session.title}${branch}`
  }
}

/** Rename in place. Enter commits, Escape reverts, blur commits. */
function InlineRename(props: {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(props.value)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.select()
  }, [])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed === '') props.onCancel()
    else props.onCommit(trimmed)
  }

  return (
    <input
      ref={input}
      className="rename"
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') props.onCancel()
      }}
    />
  )
}

function displayName(project: Project): string {
  return project.name ?? basename(project.path)
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function initial(account: Account | undefined, fallback: string): string {
  const source = account?.email ?? fallback
  return source.slice(0, 1).toUpperCase()
}

/**
 * Memoised: the app root re-renders on every streamed frame, and this subtree
 * does not change while an answer arrives.
 *
 * NOT YET EFFECTIVE. memo compares props shallowly, and the owner still passes
 * a dozen inline arrows plus a fresh `inbox` object and `usageSources` array,
 * so the comparison fails every time. The internal useMemos above are what is
 * saving work today. Finishing this means giving those props stable
 * identities in App.tsx — mechanical, but too broad a change to make
 * carelessly.
 */
export const Sidebar = memo(SidebarComponent)
