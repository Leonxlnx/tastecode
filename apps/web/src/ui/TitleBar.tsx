import { memo } from 'react'
import { PanelLeft } from 'lucide-react'
import { DEFAULT_KEYBINDINGS, shortcutAria, type Keybindings } from '../shortcuts.js'

/**
 * Title bar. Holds the window-level sidebar control.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons.
 */
function TitleBarComponent(props: {
  collapsed: boolean
  keybindings?: Keybindings | undefined
  onToggleRail: () => void
}) {
  const keybindings = props.keybindings ?? DEFAULT_KEYBINDINGS
  return (
    <header className="titlebar">
      <button
        type="button"
        className="icon-btn icon-btn--always titlebar__toggle"
        onClick={props.onToggleRail}
        aria-label={props.collapsed ? 'Show sidebar' : 'Hide sidebar'}
        title={props.collapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!props.collapsed}
        aria-keyshortcuts={shortcutAria(keybindings.toggleSidebar)}
      >
        <PanelLeft size={15} aria-hidden />
      </button>
      <span className="titlebar__drag-region" aria-hidden />
    </header>
  )
}

/** Window chrome is independent of streamed thread state. */
export const TitleBar = memo(TitleBarComponent)
