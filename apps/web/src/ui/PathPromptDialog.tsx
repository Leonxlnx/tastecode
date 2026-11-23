import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/sheet.css'
import '../styles/path-prompt.css'

/**
 * In-app path prompt used in browser mode where Electron's native open dialog
 * is unavailable and `window.prompt()` may be disabled or unsupported.
 */
export function PathPromptDialog(props: {
  title: string
  label: string
  placeholder: string
  action: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onCancel)
  const titleId = useId()
  const inputId = useId()
  const [value, setValue] = useState('')
  const trimmed = value.trim()

  return createPortal(
    <div className="sheet" role="presentation" onKeyDown={dialog.onKeyDown}>
      <button
        className="sheet__scrim"
        type="button"
        tabIndex={-1}
        onClick={props.onCancel}
        aria-label="Cancel"
      />
      <div
        className="sheet__panel path-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog.panel}
        tabIndex={-1}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!trimmed) return
            props.onSubmit(trimmed)
          }}
        >
          <h2 className="path-prompt__title" id={titleId}>
            {props.title}
          </h2>
          <div className="path-prompt__field">
            <label className="path-prompt__label" htmlFor={inputId}>
              {props.label}
            </label>
            <input
              id={inputId}
              className="path-prompt__input"
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={props.placeholder}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="path-prompt__actions">
            <button className="path-prompt__cancel" type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button className="path-prompt__submit" type="submit" disabled={trimmed.length === 0}>
              {props.action}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
