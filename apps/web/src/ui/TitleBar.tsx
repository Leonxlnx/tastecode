import { memo, useEffect, useMemo, useState } from 'react'
import {
  IconCopy as Restore,
  IconLayoutSidebar as PanelLeft,
  IconMinus as Minimize,
  IconSquare as Maximize,
  IconX as Close,
} from '@tabler/icons-react'
import { isLinux, windowControlApi, type WindowControls } from '../bridge.js'
import { DEFAULT_KEYBINDINGS, shortcutAria, type Keybindings } from '../shortcuts.js'

/**
 * Caption buttons for Linux, where the window is frameless and no native
 * controls exist — Windows draws its own through titleBarOverlay and macOS
 * keeps the traffic lights.
 */
function LinuxWindowControls(props: { controls: WindowControls }) {
  const { controls } = props
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let live = true
    void controls.isMaximized().then((value) => {
      if (live) setMaximized(value)
    })
    const off = controls.onMaximizedChange(setMaximized)
    return () => {
      live = false
      off()
    }
  }, [controls])
  return (
    <div className="titlebar__controls">
      <button
        type="button"
        className="icon-btn icon-btn--always titlebar__winbtn"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void controls.minimize()}
      >
        <Minimize size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--always titlebar__winbtn"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void controls.toggleMaximize()}
      >
        {maximized ? <Restore size={14} aria-hidden /> : <Maximize size={14} aria-hidden />}
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--always titlebar__winbtn titlebar__winbtn--close"
        aria-label="Close"
        title="Close"
        onClick={() => void controls.close()}
      >
        <Close size={15} aria-hidden />
      </button>
    </div>
  )
}

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
  const controls = useMemo(() => (isLinux() ? windowControlApi() : undefined), [])
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
      {controls !== undefined ? <LinuxWindowControls controls={controls} /> : null}
    </header>
  )
}

/** Window chrome is independent of streamed thread state. */
export const TitleBar = memo(TitleBarComponent)
