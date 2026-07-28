import { useState } from 'react'

/**
 * The rail. Collapsible, because a thread deserves the full window when you are
 * reading it and the rail is only needed when you are switching.
 *
 * Nothing in here wraps. Session titles are user text of arbitrary length, and
 * a rail whose rows change height as titles grow is visually unstable — every
 * label truncates instead.
 */

export type Session = {
  id: string
  title: string
  status: 'running' | 'idle' | 'failed'
}

export type Project = {
  path: string
  sessions: Session[]
}

export function Sidebar(props: {
  projects: Project[]
  activeSessionId: string | undefined
  providerName: string
  collapsed: boolean
  onToggle: () => void
  onAddProject: () => void
  onNewSession: (projectPath: string) => void
  onSelectSession: (id: string) => void
}) {
  if (props.collapsed) {
    return (
      <nav className="rail rail--collapsed">
        <button className="icon-btn icon-btn--always" onClick={props.onToggle} title="Show sidebar">
          <PanelGlyph />
        </button>
      </nav>
    )
  }

  return (
    <nav className="rail">
      <div className="rail__top">
        <span className="rail__brand">{props.providerName}</span>
        <button className="icon-btn icon-btn--always" onClick={props.onToggle} title="Hide sidebar">
          <PanelGlyph />
        </button>
      </div>

      <div className="rail__actions">
        <button
          className="navitem"
          onClick={() => {
            const first = props.projects[0]
            if (first) props.onNewSession(first.path)
            else props.onAddProject()
          }}
        >
          <PencilGlyph />
          <span>New session</span>
        </button>
        <button className="navitem" onClick={props.onAddProject}>
          <FolderGlyph />
          <span>Add project</span>
        </button>
      </div>

      <div className="rail__body">
        <p className="section">Projects</p>
        {props.projects.length === 0 ? (
          <p className="rail__hint">Nothing here yet.</p>
        ) : (
          props.projects.map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              activeSessionId={props.activeSessionId}
              onNewSession={() => props.onNewSession(project.path)}
              onSelectSession={props.onSelectSession}
            />
          ))
        )}
      </div>
    </nav>
  )
}

function ProjectRow(props: {
  project: Project
  activeSessionId: string | undefined
  onNewSession: () => void
  onSelectSession: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  const count = props.project.sessions.length

  return (
    <section className="proj">
      <div className="proj__head">
        <button className="proj__toggle" onClick={() => setOpen(!open)} title={props.project.path}>
          <span className="proj__chev" data-open={open}>
            <ChevronGlyph />
          </span>
          {/* Stable colour per repo, derived from its path — tells projects
              apart at a glance without asking the user to choose one. */}
          <span className="proj__mark" style={{ background: markColour(props.project.path) }} />
          <span className="proj__name">{basename(props.project.path)}</span>
        </button>
        <button className="icon-btn" onClick={props.onNewSession} title="New session here">
          <PlusGlyph />
        </button>
      </div>

      {/* Height animates from a measured max rather than 'auto', which cannot be
          transitioned. Rows are a known height, so the cap is exact. */}
      <div
        className="proj__drawer"
        data-open={open && count > 0}
        style={{ maxHeight: open ? `${count * 30}px` : '0px' }}
      >
        <ul className="proj__sessions">
          {props.project.sessions.map((session) => (
            <li key={session.id}>
              <button
                className={`sess ${session.id === props.activeSessionId ? 'is-active' : ''}`}
                onClick={() => props.onSelectSession(session.id)}
                title={session.title}
              >
                <span className="sess__title">{session.title}</span>
                {session.status === 'running' ? <span className="spinner" /> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function markColour(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0
  return `oklch(70% 0.1 ${hash % 360})`
}

function PanelGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PencilGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
