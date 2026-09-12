import {
  IconHistory as History,
  IconLoader2 as LoaderCircle,
  IconX as X,
} from '@tabler/icons-react'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/rollback.css'

export type Checkpoint = {
  id: number
  seq: number
  label: string
  createdAt: number
}

export function RollbackDialog(props: {
  checkpoints: Checkpoint[]
  inspection: { checkpoint: Checkpoint; files: string[] } | undefined
  loadingId: number | undefined
  restoring: boolean
  onInspect: (checkpoint: Checkpoint) => void
  onRestore: () => void
  onClose: () => void
}) {
  const selected = props.inspection?.checkpoint
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Restore checkpoint"
      onKeyDown={dialog.onKeyDown}
    >
      <button className="sheet__scrim" onClick={props.onClose} aria-label="Close checkpoints" />
      <div className="sheet__panel rollback" ref={dialog.panel} tabIndex={-1}>
        <header className="sheet__head">
          <div>
            <h2 className="sheet__title">Return to a checkpoint</h2>
            <p className="rollback__intro">Files and conversation move back together.</p>
          </div>
          <button className="icon-btn icon-btn--always" onClick={props.onClose} title="Close">
            <X size={13} aria-hidden />
          </button>
        </header>

        <div className="rollback__list" aria-label="Checkpoints">
          {[...props.checkpoints].reverse().map((checkpoint) => (
            <button
              className={`rollback__checkpoint${selected?.id === checkpoint.id ? ' is-selected' : ''}`}
              key={checkpoint.id}
              onClick={() => props.onInspect(checkpoint)}
              disabled={props.loadingId !== undefined || props.restoring}
            >
              <History size={13} aria-hidden />
              <span>
                <strong>Before “{checkpoint.label}”</strong>
                <small>{new Date(checkpoint.createdAt).toLocaleString()}</small>
              </span>
              {props.loadingId === checkpoint.id ? (
                <LoaderCircle className="spinner" aria-hidden />
              ) : null}
            </button>
          ))}
        </div>

        {props.inspection ? (
          <section className="rollback__confirm">
            <p>
              This restores the conversation and{' '}
              {props.inspection.files.length === 0
                ? 'leaves the current files unchanged.'
                : `${props.inspection.files.length} changed file${props.inspection.files.length === 1 ? '' : 's'}:`}
            </p>
            {props.inspection.files.length > 0 ? (
              <ul>
                {props.inspection.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            ) : null}
            <p className="rollback__safe">You can undo this restore afterwards.</p>
            <div className="rollback__actions">
              <button className="ghost" onClick={props.onClose} disabled={props.restoring}>
                Cancel
              </button>
              <button className="btn" onClick={props.onRestore} disabled={props.restoring}>
                {props.restoring ? 'Restoring…' : 'Restore checkpoint'}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
