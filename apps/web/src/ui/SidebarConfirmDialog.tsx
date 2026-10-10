import { useId } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/sidebar-confirm.css'

/** Splits on either separator so Windows paths keep their folder name too. */
function splitPath(path: string): { parent: string; leaf: string } {
  const match = /^(.*[\\/])?([^\\/]+)[\\/]*$/.exec(path)
  return match ? { parent: match[1] ?? '', leaf: match[2] ?? '' } : { parent: '', leaf: path }
}

/**
 * Built like the prompt bar rather than a generic modal: the same surface and
 * 20px corner, with the buttons docked 10px in so their corners stay concentric
 * with it. The folder path is shown because it is the thing that survives.
 * Loaded on demand, with its stylesheet, the first time a project action asks.
 */
export function SidebarConfirmDialog(props: {
  title: string
  body: string
  action: string
  destructive: boolean
  path: string
  onConfirm: () => void
  onClose: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)
  const titleId = useId()
  const bodyId = useId()
  const { parent, leaf } = splitPath(props.path)

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
        <p className="sidebar-confirm__path" title={props.path}>
          {parent ? (
            <span className="sidebar-confirm__parent">
              <bdi>{parent}</bdi>
            </span>
          ) : null}
          <span className="sidebar-confirm__leaf">{leaf}</span>
        </p>
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
