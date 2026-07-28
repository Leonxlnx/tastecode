import { useState } from 'react'

/**
 * Rail layout follows the shape the first-party agent apps settled on: a
 * workspace switcher, a short action list, then sections (Projects, Recents)
 * with sentence-case headings. No status readout pinned to the bottom — that
 * was a decoration masquerading as information.
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
  onAddProject: () => void
  onNewSession: (projectPath: string) => void
  onSelectSession: (id: string) => void
}) {
  return (
    <nav className="rail">
      <div className="rail__top">
        <button className="workspace">
          <span className="workspace__name">{props.providerName}</span>
          <Chevron down />
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
          <PencilIcon />
          <span>New session</span>
        </button>
        <button className="navitem" onClick={props.onAddProject}>
          <FolderIcon />
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
  const name = basename(props.project.path)

  return (
    <section className="proj">
      <div className="proj__head">
        <button className="proj__toggle" onClick={() => setOpen(!open)} title={props.project.path}>
          {/* A stable colour per project, derived from its path. Cheap way to
              tell repos apart at a glance without asking the user to pick. */}
          <span className="proj__mark" style={{ background: markColour(props.project.path) }} />
          <span className="proj__name">{name}</span>
        </button>
        <button className="icon-btn" onClick={props.onNewSession} title="New session here">
          <PlusIcon />
        </button>
      </div>

      {open && props.project.sessions.length > 0 ? (
        <ul className="proj__sessions">
          {props.project.sessions.map((session) => (
            <li key={session.id}>
              <button
                className={`sess ${session.id === props.activeSessionId ? 'is-active' : ''}`}
                onClick={() => props.onSelectSession(session.id)}
                title={session.title}
              >
                <span className="sess__title">{session.title}</span>
                {session.status === 'running' ? <Spinner /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Deterministic, muted, and never the same hue twice in a row for short lists. */
function markColour(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0
  return `oklch(66% 0.11 ${hash % 360})`
}

function Spinner() {
  return <span className="spinner" aria-label="running" />
}

function Chevron({ down }: { down?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={down ? 'M4 6.5l4 4 4-4' : 'M6 4l4 4-4 4'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function PencilIcon() {
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

function FolderIcon() {
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
