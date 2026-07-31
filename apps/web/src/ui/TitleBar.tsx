import { PanelLeft } from 'lucide-react'
import { isMacOS } from '../bridge.js'
import { SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'

/**
 * Title bar. Holds the window-level controls — the sidebar toggle belongs here
 * rather than inside the sidebar it hides, so its position never moves.
 *
 * There is deliberately no product name in the rail below. Labelling the rail
 * with the app's own name is like writing "Browser" at the top of a browser;
 * the window already says what this is.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons.
 */
export function TitleBar(props: { collapsed: boolean; onToggleRail: () => void }) {
  const shortcut = shortcutLabel(SHORTCUTS.toggleSidebar, isMacOS())

  return (
    <header className="titlebar">
      <button
        className="icon-btn icon-btn--always titlebar__toggle"
        onClick={props.onToggleRail}
        title={`${props.collapsed ? 'Show sidebar' : 'Hide sidebar'} (${shortcut})`}
        aria-pressed={!props.collapsed}
        aria-keyshortcuts={shortcutAria(SHORTCUTS.toggleSidebar)}
      >
        <PanelLeft size={15} aria-hidden />
      </button>
    </header>
  )
}
