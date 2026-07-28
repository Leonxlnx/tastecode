import { useState } from 'react'
import type { ConnectionState } from '../transport.js'

/**
 * One unified rail: projects expand into their sessions, settings pinned at the
 * bottom. Both first-party desktop apps converged on this shape after trying a
 * separate project column, and they were right — a second column costs width
 * and buys nothing until you have far more projects than anyone has.
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
  connection: ConnectionState
  onAddProject: () => void
  onNewSession: (projectPath: string) => void
  onSelectSession: (id: string) => void
}) {
  return (
    <nav className="rail">
      <div className="rail__head">
        <span className="label">Projects</span>
        <button className="icon-btn" onClick={props.onAddProject} title="Add project">
          <PlusIcon />
        </button>
      </div>

      <div className="rail__body">
        {props.projects.length === 0 ? (
          <p className="rail__empty">
            No projects yet.
            <button className="linkish" onClick={props.onAddProject}>
              Add a folder
            </button>
            to begin.
          </p>
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

      {/* Connection state lives down here, quiet, rather than shouting next to
          the product name. It only earns attention when it is wrong. */}
      <div className="rail__foot">
        <span className={`dot dot--${props.connection}`} aria-hidden />
        <span className="label">{props.connection === 'open' ? 'Codex' : props.connection}</span>
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
          <ChevronIcon open={open} />
          <span className="proj__name">{name}</span>
          <span className="proj__count">{props.project.sessions.length}</span>
        </button>
        <button className="icon-btn" onClick={props.onNewSession} title="New session">
          <PlusIcon />
        </button>
      </div>

      {open ? (
        <ul className="proj__sessions">
          {props.project.sessions.map((session) => (
            <li key={session.id}>
              <button
                className={`sess ${session.id === props.activeSessionId ? 'is-active' : ''}`}
                onClick={() => props.onSelectSession(session.id)}
              >
                <span className={`dot dot--${session.status}`} aria-hidden />
                <span className="sess__title">{session.title}</span>
              </button>
            </li>
          ))}
          {props.project.sessions.length === 0 ? (
            <li className="proj__none label">No sessions</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
      className="chev"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
