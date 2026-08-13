import { memo } from 'react'
import { PanelLeft } from 'lucide-react'
import { SHORTCUTS, shortcutAria } from '../shortcuts.js'

/**
 * Title bar. Holds the window-level sidebar control.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons.
 */
function TitleBarComponent(props: { collapsed: boolean; onToggleRail: () => void }) {
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
    </header>
  )
}

/** Window chrome is independent of streamed thread state. */
export const TitleBar = memo(TitleBarComponent)
