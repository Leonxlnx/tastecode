import { useEffect, useRef, useState } from 'react'
import type { Project } from './Sidebar.js'

/**
 * Header above the thread: which project this session belongs to, and the
 * switcher for moving between them. Sits at the top because the answer to
 * "where am I working" must never require a glance elsewhere.
 */
export function StageHeader(props: {
  projects: Project[]
  activePath: string | undefined
  title: string | undefined
  onSelectProject: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <header className="stagehead">
      <div className="modelwrap" ref={wrap}>
        <button
          className="picker"
          onClick={() => setOpen(!open)}
          disabled={props.projects.length === 0}
        >
          <span>{props.activePath ? basename(props.activePath) : 'No project'}</span>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M4 6.5l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {open ? (
          <ul className="menu" role="listbox">
            {props.projects.map((project) => (
              <li key={project.path}>
                <button
                  className={`menu__item ${project.path === props.activePath ? 'is-active' : ''}`}
                  onClick={() => {
                    props.onSelectProject(project.path)
                    setOpen(false)
                  }}
                >
                  <span className="menu__name">{basename(project.path)}</span>
                  <span className="menu__desc">{project.path}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {props.title ? <span className="stagehead__title">{props.title}</span> : null}
    </header>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
