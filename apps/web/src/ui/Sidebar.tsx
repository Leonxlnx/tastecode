import { type DragEvent, useEffect, useRef, useState } from 'react'
import type { Account, ProviderId, ThreadInboxStatus, ThreadLifecycle } from '@harness/contracts'
import { Ellipsis, Folder, FolderPen, Plus, Search, X } from 'lucide-react'
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

export function Sidebar(props: {
  projects: Project[]
  activeProjectPath: string | undefined
  activeSessionId: string | undefined
  account: Account | undefined
  providerName: string
  mode?: 'classic' | 'inbox'
  onModeChange?: ((mode: 'classic' | 'inbox') => void) | undefined
  inbox?: InboxActions | undefined
  collapsed: boolean
  onClose: () => void
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

  const pinnedSessions = props.projects.flatMap((project) =>
    project.sessions
      .filter((session) => session.pinned)
      .map((session) => ({ projectPath: project.path, session })),
  )
  const orderedProjects = [
    ...props.projects.filter((project) => project.pinned),
    ...props.projects.filter((project) => !project.pinned),
  ].map((project) => ({
    ...project,
    sessions: project.sessions.filter((session) => !session.pinned),
  }))

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
            className="navitem"
            onClick={props.onAddProject}
            aria-keyshortcuts={shortcutAria(SHORTCUTS.newProject)}
          >
            <FolderPen size={15} aria-hidden />
            <span>New project</span>
            <ShortcutHint>{shortcutLabel(SHORTCUTS.newProject, macOS)}</ShortcutHint>
          </button>
          <button
            type="button"
            className="search search--button"
            onClick={() => props.onOpenSearch(inbox && scope ? scope : undefined)}
            aria-keyshortcuts={shortcutAria(SHORTCUTS.searchSessions)}
          >
            <Search size={13} aria-hidden />
            <span>Search chats</span>
            <ShortcutHint>{shortcutLabel(SHORTCUTS.searchSessions, macOS)}</ShortcutHint>
          </button>
          <div className="rail__version" role="group" aria-label="Sidebar version">
            <button
              type="button"
              aria-pressed={!inbox}
              onClick={() => props.onModeChange?.('classic')}
            >
              V1 Classic
            </button>
            <button
              type="button"
              aria-pressed={inbox}
              onClick={() => props.onModeChange?.('inbox')}
            >
              V2 Inbox
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
          <Menu
            drop="up"
            label="Account"
            panelClassName="menu--settings"
            trigger={() => (
              <span className="account">
                <span className="account__avatar">
                  {initial(props.account, props.providerName)}
                </span>
                <span className="account__text">
                  <span className="account__name">
                    {props.account?.email ?? props.providerName}
                  </span>
                  {props.account?.plan ? (
                    <span className="account__plan">{props.account.plan}</span>
                  ) : null}
                </span>
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
    </div>
  )
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
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<'archive' | 'remove'>()
  const [draggedSessionId, setDraggedSessionId] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: DropPosition
  }>()
  const expanded = open || props.forceOpen
  const count = props.project.sessions.length
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
              className="proj__toggle"
              onClick={() => setOpen(!expanded)}
              onDoubleClick={() => setRenaming(true)}
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
              trigger={() => (
                <span className="dots">
                  <Ellipsis size={14} aria-hidden />
                </span>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    title={props.project.pinned ? 'Unpin' : 'Pin to top'}
                    onClick={() => {
                      props.onTogglePin(props.project.path)
                      close()
                    }}
                  />
                  {isDesktop ? (
                    <MenuItem
                      title="Open in Explorer"
                      onClick={() => {
                        void revealPath(props.project.path)
                        close()
                      }}
                    />
                  ) : null}
                  <MenuItem
                    title="Edit name"
                    onClick={() => {
                      setRenaming(true)
                      close()
                    }}
                  />
                  <MenuItem
                    title="Archive chats"
                    onClick={() => {
                      setConfirming('archive')
                      close()
                    }}
                  />
                  <MenuItem
                    title="Remove from sidebar"
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
          title={confirming === 'archive' ? 'Archive all chats?' : 'Remove project from sidebar?'}
          body={
            confirming === 'archive'
              ? `This archives every chat in ${displayName(props.project)}. Files on your computer won't be deleted.`
              : "This removes the project from the app. Files on your computer and existing chats won't be deleted."
          }
          action={confirming === 'archive' ? 'Archive chats' : 'Remove project'}
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

      <div
        className="proj__drawer"
        data-open={expanded && count > 0}
        style={{ maxHeight: expanded ? `${count * 30}px` : '0px' }}
      >
        <ul className="proj__sessions">
          {props.project.sessions.map((session) => (
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
        className={`sess ${props.active ? 'is-active' : ''}`}
        onClick={props.onSelect}
        onDoubleClick={() => setRenaming(true)}
        aria-label={sessionLabel(props.session)}
        title={sessionLabel(props.session)}
      >
        <span className="sess__title">{props.session.title}</span>
        <SessionStatus status={props.session.status} />
      </button>

      <Menu
        drop="down"
        align="right"
        label={`Options for ${props.session.title}`}
        triggerClassName="sess__menu"
        panelClassName="menu--sidebar"
        trigger={() => <Ellipsis size={14} aria-hidden />}
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
    </li>
  )
}

function SidebarConfirmDialog(props: {
  title: string
  body: string
  action: string
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
            <button className="ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button className="btn btn--danger" onClick={props.onConfirm}>
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
