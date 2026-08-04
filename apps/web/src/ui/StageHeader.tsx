import { ChevronDown, GitBranch, History, SquareTerminal } from 'lucide-react'
import { SHORTCUTS, shortcutAria } from '../shortcuts.js'
import type { Project } from './Sidebar.js'
import { Menu, MenuItem } from './Menu.js'

/**
 * Header above the thread: which project this session belongs to, and the
 * switcher for moving between them. It sits at the top because "where am I
 * working" must never require a glance elsewhere.
 */
export function StageHeader(props: {
  projects: Project[]
  activePath: string | undefined
  title: string | undefined
  checkpointCount: number
  worktreeBranch: string | undefined
  terminalOpen: boolean
  onSelectProject: (path: string) => void
  onOpenRollback: () => void
  onToggleTerminal: () => void
}) {
  return (
    <header className="stagehead">
      <Menu
        label="Project"
        drop="down"
        disabled={props.projects.length === 0}
        shortcutAria={shortcutAria(SHORTCUTS.switchProject)}
        trigger={() => (
          <span className="picker">
            <span>{props.activePath ? basename(props.activePath) : 'No project'}</span>
            <ChevronDown size={11} aria-hidden />
          </span>
        )}
      >
        {(close) => (
          <>
            {props.projects.map((project) => (
              <MenuItem
                key={project.path}
                title={basename(project.path)}
                detail={project.path}
                active={project.path === props.activePath}
                onClick={() => {
                  props.onSelectProject(project.path)
                  close()
                }}
              />
            ))}
          </>
        )}
      </Menu>

      {props.title ? <span className="stagehead__title">{props.title}</span> : null}

      <div className="stagehead__tools">
        {props.title ? (
          <button
            className={`ghost terminal-trigger${props.terminalOpen ? ' is-open' : ''}`}
            aria-pressed={props.terminalOpen}
            onClick={props.onToggleTerminal}
          >
            <SquareTerminal size={13} aria-hidden />
            Terminal
          </button>
        ) : null}
        {props.worktreeBranch ? (
          <span className="worktree-branch" title="Isolated checkout">
            <GitBranch size={12} aria-hidden />
            {props.worktreeBranch}
          </span>
        ) : null}
        {props.checkpointCount > 0 ? (
          <button className="ghost rollback-trigger" onClick={props.onOpenRollback}>
            <History size={12} aria-hidden />
            {props.checkpointCount} checkpoint{props.checkpointCount === 1 ? '' : 's'}
          </button>
        ) : null}
      </div>
    </header>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
