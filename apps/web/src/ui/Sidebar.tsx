import { type DragEvent, useEffect, useRef, useState } from 'react'
import type { Account } from '@harness/contracts'
import {
  Archive,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPen,
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { isMacOS } from '../bridge.js'
import { SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'
import { Menu, MenuItem } from './Menu.js'
import { ShortcutHint } from './ShortcutHint.js'

/**
 * The rail. Collapsible, searchable, and everything in it can be renamed.
 *
 * Nothing wraps: titles are arbitrary user text and a list whose rows change
 * height as titles grow is visually unstable.
 */

export type Session = {
  id: string
  title: string
  status: 'running' | 'attention' | 'idle' | 'failed'
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
  collapsed: boolean
  onClose: () => void
  onAddProject: () => void
  onNewSession: (projectPath: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
  onOpenSettings: () => void
}) {
  const [query, setQuery] = useState('')
  const [edgeRevealed, setEdgeRevealed] = useState(false)
  const macOS = isMacOS()

  useEffect(() => {
    if (!props.collapsed) setEdgeRevealed(false)
  }, [props.collapsed])

  const term = query.trim().toLowerCase()
  const visible = term
    ? props.projects
        .map((project) => ({
          ...project,
          sessions: project.sessions.filter((s) => s.title.toLowerCase().includes(term)),
        }))
        .filter(
          (project) =>
            project.sessions.length > 0 || displayName(project).toLowerCase().includes(term),
        )
    : props.projects

  const pinned = visible.filter((p) => p.pinned)
  const rest = visible.filter((p) => !p.pinned)

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
          <div className="search">
            <Search size={13} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              spellCheck={false}
            />
            {query ? (
              <button className="chip__x" onClick={() => setQuery('')} title="Clear">
                <X size={10} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        <div className="rail__body">
          {pinned.length > 0 ? (
            <>
              <p className="section">Pinned</p>
              {pinned.map((project) => (
                <ProjectRow
                  key={project.path}
                  project={project}
                  {...props}
                  forceOpen={term !== ''}
                />
              ))}
            </>
          ) : null}

          <p className="section">Projects</p>
          {rest.length === 0 ? (
            <p className="rail__hint">{term ? 'Nothing matches.' : 'Nothing here yet.'}</p>
          ) : (
            rest.map((project) => (
              <ProjectRow key={project.path} project={project} {...props} forceOpen={term !== ''} />
            ))
          )}
        </div>

        <div className="rail__foot">
          <Menu
            drop="up"
            label="Account"
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
                  detail="Providers, appearance, storage"
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
  onDeleteSession: (id: string) => void
  onReorderSession: (
    projectPath: string,
    sourceId: string,
    targetId: string,
    position: DropPosition,
  ) => void
}) {
  const [open, setOpen] = useState(true)
  const [renaming, setRenaming] = useState(false)
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
              <span className="proj__chev" data-open={expanded}>
                <ChevronRight size={10} aria-hidden />
              </span>
              <Folder className="proj__mark" size={12} aria-hidden />
              <span className="proj__name">{displayName(props.project)}</span>
            </button>

            <Menu
              drop="down"
              align="right"
              label="Project options"
              trigger={() => (
                <span className="dots">
                  <Ellipsis size={14} aria-hidden />
                </span>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    title="Rename"
                    onClick={() => {
                      setRenaming(true)
                      close()
                    }}
                  />
                  <MenuItem
                    title={props.project.pinned ? 'Unpin' : 'Pin to top'}
                    onClick={() => {
                      props.onTogglePin(props.project.path)
                      close()
                    }}
                  />
                  <div className="menu__rule" />
                  <MenuItem
                    title="Remove from sidebar"
                    detail="The folder on disk is untouched"
                    onClick={() => {
                      props.onRemoveProject(props.project.path)
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
      className={`sessrow ${props.active ? 'is-active' : ''} ${
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

      <span className="sess__actions">
        <button
          className="sess__action"
          onClick={() => setRenaming(true)}
          aria-label={`Rename ${props.session.title}`}
          title="Rename"
        >
          <Pencil size={13} aria-hidden />
        </button>
        <button
          className="sess__action"
          onClick={props.onDelete}
          aria-label={`Archive ${props.session.title}`}
          title="Archive"
        >
          <Archive size={14} aria-hidden />
        </button>
      </span>
    </li>
  )
}

function SessionStatus(props: { status: Session['status'] }) {
  if (props.status === 'running') {
    return (
      <span className="sess__spinner" aria-hidden>
        {BRAILLE_SPINNER_FRAMES.map((frame) => (
          <span key={frame}>{frame}</span>
        ))}
      </span>
    )
  }

  if (props.status === 'attention') {
    return <span className="sess__status-dot is-attention" aria-hidden />
  }

  if (props.status === 'failed') {
    return <span className="sess__status-dot is-failed" aria-hidden />
  }

  return null
}

function sessionLabel(session: Session): string {
  switch (session.status) {
    case 'running':
      return `${session.title}, working`
    case 'attention':
      return `${session.title}, needs attention`
    case 'failed':
      return `${session.title}, failed`
    default:
      return session.title
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
