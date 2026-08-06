import type { ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'
import { isMacOS } from '../bridge.js'
import { SHORTCUTS, shortcutAria, shortcutLabel } from '../shortcuts.js'
import { Menu, MenuItem } from './Menu.js'

/**
 * Title bar. Holds the window-level controls — the sidebar toggle belongs here
 * rather than inside the sidebar it hides, so its position never moves — and
 * the app menu (File / Edit / View / Help), which lives in the bar itself
 * because the window chrome is ours on every platform.
 *
 * Height comes from --titlebar-h, which the main process also uses for the
 * native caption buttons.
 */
export function TitleBar(props: {
  collapsed: boolean
  onToggleRail: () => void
  onNewChat: () => void
  onNewProject: () => void
  onOpenSettings: () => void
  onSearchChats: () => void
  onZoom: (action: 'in' | 'out' | 'reset') => void
  zoomAvailable: boolean
  onOpenHelp: (page: 'docs' | 'issues') => void
  onExportChat: () => void
  onShowShortcuts: () => void
}) {
  const macOS = isMacOS()
  const shortcut = shortcutLabel(SHORTCUTS.toggleSidebar, macOS)

  const editCommand = (command: 'undo' | 'redo' | 'cut' | 'copy' | 'selectAll') => {
    document.execCommand(command)
  }

  const paste = async () => {
    const target = document.activeElement
    if (
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLTextAreaElement) &&
      !(target instanceof HTMLElement && target.isContentEditable)
    ) {
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      if (text) document.execCommand('insertText', false, text)
    } catch {
      // Clipboard permission denied — the keyboard shortcut still works.
    }
  }

  const menu = (label: string, items: (close: () => void) => ReactNode) => (
    <Menu
      align="left"
      drop="down"
      label={label}
      panelLabel={label}
      triggerClassName="titlebar__menu-trigger"
      trigger={() => <>{label}</>}
    >
      {items}
    </Menu>
  )

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

      <nav className="titlebar__menus" aria-label="Application menu">
        {menu('File', (close) => (
          <>
            <MenuItem
              title="New chat"
              shortcut={shortcutLabel(SHORTCUTS.newChat, macOS)}
              onClick={() => {
                props.onNewChat()
                close()
              }}
            />
            <MenuItem
              title="New project…"
              shortcut={shortcutLabel(SHORTCUTS.newProject, macOS)}
              onClick={() => {
                props.onNewProject()
                close()
              }}
            />
            <MenuItem
              title="Export chat as Markdown"
              onClick={() => {
                props.onExportChat()
                close()
              }}
            />
            <MenuItem
              title="Settings"
              shortcut={shortcutLabel(SHORTCUTS.settings, macOS)}
              onClick={() => {
                props.onOpenSettings()
                close()
              }}
            />
          </>
        ))}
        {menu('Edit', (close) => (
          <>
            <MenuItem
              title="Undo"
              onClick={() => {
                editCommand('undo')
                close()
              }}
            />
            <MenuItem
              title="Redo"
              onClick={() => {
                editCommand('redo')
                close()
              }}
            />
            <MenuItem
              title="Cut"
              onClick={() => {
                editCommand('cut')
                close()
              }}
            />
            <MenuItem
              title="Copy"
              onClick={() => {
                editCommand('copy')
                close()
              }}
            />
            <MenuItem
              title="Paste"
              onClick={() => {
                void paste()
                close()
              }}
            />
            <MenuItem
              title="Select all"
              onClick={() => {
                editCommand('selectAll')
                close()
              }}
            />
          </>
        ))}
        {menu('View', (close) => (
          <>
            <MenuItem
              title={props.collapsed ? 'Show sidebar' : 'Hide sidebar'}
              shortcut={shortcut}
              onClick={() => {
                props.onToggleRail()
                close()
              }}
            />
            <MenuItem
              title="Search chats"
              shortcut={shortcutLabel(SHORTCUTS.searchSessions, macOS)}
              onClick={() => {
                props.onSearchChats()
                close()
              }}
            />
            {props.zoomAvailable ? (
              <>
                <MenuItem
                  title="Zoom in"
                  onClick={() => {
                    props.onZoom('in')
                    close()
                  }}
                />
                <MenuItem
                  title="Zoom out"
                  onClick={() => {
                    props.onZoom('out')
                    close()
                  }}
                />
                <MenuItem
                  title="Reset zoom"
                  onClick={() => {
                    props.onZoom('reset')
                    close()
                  }}
                />
              </>
            ) : null}
          </>
        ))}
        {menu('Help', (close) => (
          <>
            <MenuItem
              title="Keyboard shortcuts"
              onClick={() => {
                props.onShowShortcuts()
                close()
              }}
            />
            <MenuItem
              title="Documentation"
              onClick={() => {
                props.onOpenHelp('docs')
                close()
              }}
            />
            <MenuItem
              title="Report an issue"
              onClick={() => {
                props.onOpenHelp('issues')
                close()
              }}
            />
          </>
        ))}
      </nav>

      <span className="titlebar__name">Personal Harness</span>
    </header>
  )
}
