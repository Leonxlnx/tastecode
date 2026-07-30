import { useEffect, useRef, useState } from 'react'
import type { Account } from '@harness/contracts'
import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPen,
  LoaderCircle,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { Menu, MenuItem } from './Menu.js'

/**
 * The rail. Collapsible, searchable, and everything in it can be renamed.
 *
 * Nothing wraps: titles are arbitrary user text and a list whose rows change
 * height as titles grow is visually unstable.
 */

export type Session = {
  id: string
  title: string
  status: 'running' | 'idle' | 'failed'
}

export type Project = {
  path: string
  /** User-chosen name. Falls back to the folder name. */
  name?: string
  sessions: Session[]
  pinned?: boolean
}

export function Sidebar(props: {
  projects: Project[]
  activeSessionId: string | undefined
  account: Account | undefined
  providerName: string
  collapsed: boolean
  onAddProject: () => void
  onNewSession: (projectPath: string) => void
  onSelectSession: (id: string) => void
  onRenameProject: (path: string, name: string) => void
  onRemoveProject: (path: string) => void
  onTogglePin: (path: string) => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
  onOpenSettings: () => void
}) {
  const [query, setQuery] = useState('')

  // Collapsed is an empty strip: the toggle that brings it back lives in the
  // title bar, so it stays put instead of moving with the thing it controls.
  if (props.collapsed) return <nav className="rail rail--collapsed" />

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
    <nav className="rail">
      <div className="rail__actions">
        <button
          className="navitem"
          onClick={() => {
            const first = props.projects[0]
            if (first) props.onNewSession(first.path)
            else props.onAddProject()
          }}
        >
          <Plus size={15} aria-hidden />
          <span>New chat</span>
        </button>
        <button className="navitem" onClick={props.onAddProject}>
          <FolderPen size={15} aria-hidden />
          <span>New project</span>
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
              <ProjectRow key={project.path} project={project} {...props} forceOpen={term !== ''} />
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
              <span className="account__avatar">{initial(props.account, props.providerName)}</span>
              <span className="account__text">
                <span className="account__name">{props.account?.email ?? props.providerName}</span>
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
}) {
  const [open, setOpen] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const expanded = open || props.forceOpen
  const count = props.project.sessions.length

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

            <button
              className="icon-btn"
              onClick={() => props.onNewSession(props.project.path)}
              title="New chat here"
            >
              <Plus size={13} aria-hidden />
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
    <li className="sessrow">
      <button
        className={`sess ${props.active ? 'is-active' : ''}`}
        onClick={props.onSelect}
        onDoubleClick={() => setRenaming(true)}
        title={props.session.title}
      >
        <span className="sess__title">{props.session.title}</span>
        {props.session.status === 'running' ? (
          <LoaderCircle className="spinner" aria-hidden />
        ) : null}
      </button>

      <Menu
        drop="down"
        align="right"
        label="Chat options"
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
              title="Delete"
              onClick={() => {
                props.onDelete()
                close()
              }}
            />
          </>
        )}
      </Menu>
    </li>
  )
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
