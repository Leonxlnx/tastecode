import { useId } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/sidebar-confirm.css'

/**
 * Built like the prompt bar rather than a generic modal: the same surface and
 * 20px corner, with the buttons docked 10px in so their corners stay concentric
 * with it. Loaded on demand, with its stylesheet, the first time a project
 * action asks.
 */
export function SidebarConfirmDialog(props: {
  title: string
  body: string
  action: string
  destructive: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)
  const titleId = useId()
  const bodyId = useId()

  return createPortal(
    <div className="sheet" role="presentation" onKeyDown={dialog.onKeyDown}>
      <button
        className="sheet__scrim"
        type="button"
        tabIndex={-1}
        onClick={props.onClose}
        aria-label="Cancel"
      />
      <div
        className="sheet__panel sidebar-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        ref={dialog.panel}
        tabIndex={-1}
      >
        <h2 className="sidebar-confirm__title" id={titleId}>
          {props.title}
        </h2>
        <p className="sidebar-confirm__body" id={bodyId}>
          {props.body}
        </p>
        <div className="sidebar-confirm__actions">
          <button
            className="sidebar-confirm__cancel"
            type="button"
            onClick={props.onClose}
            autoFocus
          >
            Cancel
          </button>
          <button
            className={`sidebar-confirm__confirm${props.destructive ? ' is-destructive' : ''}`}
            type="button"
            onClick={props.onConfirm}
          >
            {props.action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
