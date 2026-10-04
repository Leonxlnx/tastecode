import { IconX as X } from '@tabler/icons-react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/sidebar-confirm.css'

/** Loaded on demand, with its stylesheet, the first time a project action asks. */
export function SidebarConfirmDialog(props: {
  title: string
  body: string
  action: string
  destructive: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)

  return createPortal(
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onKeyDown={dialog.onKeyDown}
    >
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Cancel" />
      <div className="sheet__panel sidebar-confirm" ref={dialog.panel} tabIndex={-1}>
        <header className="sheet__head">
          <h2 className="sheet__title">{props.title}</h2>
          <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
            <X size={13} aria-hidden />
          </button>
        </header>
        <section className="sheet__section">
          <p>{props.body}</p>
          <div className="sidebar-confirm__actions">
            <button className="ghost" onClick={props.onClose} autoFocus>
              Cancel
            </button>
            <button
              className={`btn${props.destructive ? ' btn--danger' : ''}`}
              onClick={props.onConfirm}
            >
              {props.action}
            </button>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  )
}
