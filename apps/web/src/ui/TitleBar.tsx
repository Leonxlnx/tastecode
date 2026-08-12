import { memo } from 'react'
import { Maximize2, Minimize2, PanelLeft, PanelRight, PanelRightClose } from 'lucide-react'
import { SHORTCUTS, shortcutAria } from '../shortcuts.js'

/**
 * Title bar. Holds the window-level controls — the sidebar toggle belongs here
 * rather than inside the sidebar it hides, so its position never moves.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons.
 */
function TitleBarComponent(props: {
  collapsed: boolean
  workspacePanelOpen: boolean
  workspacePanelExpanded: boolean
  onToggleRail: () => void
  onToggleWorkspacePanel: () => void
  onToggleWorkspacePanelExpanded: () => void
}) {
  return (
    <header className="titlebar">
      <button
        className="icon-btn icon-btn--always titlebar__toggle"
        onClick={props.onToggleRail}
        title={props.collapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!props.collapsed}
        aria-keyshortcuts={shortcutAria(SHORTCUTS.toggleSidebar)}
      >
        <PanelLeft size={15} aria-hidden />
      </button>

      <div className="titlebar__actions">
        <button
          className={`icon-btn icon-btn--always titlebar__toggle titlebar__workspace-expand${props.workspacePanelOpen ? ' is-visible' : ''}`}
          onClick={props.onToggleWorkspacePanelExpanded}
          title={props.workspacePanelExpanded ? 'Restore sidebar width' : 'Expand across chat'}
          aria-label={props.workspacePanelExpanded ? 'Restore sidebar width' : 'Expand across chat'}
          aria-pressed={props.workspacePanelExpanded}
          aria-hidden={!props.workspacePanelOpen}
          tabIndex={props.workspacePanelOpen ? 0 : -1}
        >
          {props.workspacePanelExpanded ? (
            <Minimize2 size={15} aria-hidden />
          ) : (
            <Maximize2 size={15} aria-hidden />
          )}
        </button>
        <button
          className={`icon-btn icon-btn--always titlebar__toggle${props.workspacePanelOpen ? ' is-open' : ''}`}
          onClick={props.onToggleWorkspacePanel}
          title={props.workspacePanelOpen ? 'Hide workspace sidebar' : 'Show workspace sidebar'}
          aria-label={
            props.workspacePanelOpen ? 'Hide workspace sidebar' : 'Show workspace sidebar'
          }
          aria-pressed={props.workspacePanelOpen}
        >
          <span className="titlebar__workspace-toggle-glyph is-closed" aria-hidden>
            <PanelRight size={15} />
          </span>
          <span className="titlebar__workspace-toggle-glyph is-open" aria-hidden>
            <PanelRightClose size={15} />
          </span>
        </button>
      </div>
    </header>
  )
}

/** Window chrome is independent of streamed thread state. */
export const TitleBar = memo(TitleBarComponent)
