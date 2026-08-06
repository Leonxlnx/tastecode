import { useEffect } from 'react'
import { X } from 'lucide-react'
import { isMacOS } from '../bridge.js'
import { SHORTCUTS, shortcutLabel } from '../shortcuts.js'

const ROWS = [
  { shortcut: SHORTCUTS.commandPalette, label: 'Command palette' },
  { shortcut: SHORTCUTS.newChat, label: 'New chat' },
  { shortcut: SHORTCUTS.switchProject, label: 'Switch project' },
  { shortcut: SHORTCUTS.newProject, label: 'New project' },
  { shortcut: SHORTCUTS.searchSessions, label: 'Search chats' },
  { shortcut: SHORTCUTS.focusComposer, label: 'Focus composer' },
  { shortcut: SHORTCUTS.toggleSidebar, label: 'Toggle sidebar' },
  { shortcut: SHORTCUTS.settings, label: 'Settings' },
] as const

/** Every keyboard shortcut in one place, reachable from Help. */
export function ShortcutsDialog(props: { onClose: () => void }) {
  const macOS = isMacOS()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  return (
    <div className="shortcuts-overlay" onClick={props.onClose}>
      <div
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcuts-dialog__head">
          <h2>Keyboard shortcuts</h2>
          <button
            className="icon-btn icon-btn--always"
            type="button"
            aria-label="Close"
            onClick={props.onClose}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <ul className="shortcuts-dialog__list">
          {ROWS.map((row) => (
            <li key={row.label}>
              <span>{row.label}</span>
              <kbd>{shortcutLabel(row.shortcut, macOS)}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
