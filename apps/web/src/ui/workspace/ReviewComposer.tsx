import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import {
  IconCheck as Check,
  IconCopy as Copy,
  IconLoader2 as LoaderCircle,
  IconSparkles as Sparkles,
} from '@tabler/icons-react'
import { isMacOS } from '../../bridge.js'
import { shortcutLabel } from '../../shortcuts.js'
import { IconMorph } from '../IconMorph.js'

const SUBMIT_KEY = shortcutLabel({ key: 'enter', primary: true }, isMacOS())

/** Ctrl or Cmd+Enter submits, Escape closes; everything else is typing. */
function composerKeys(onSubmit: () => void, onCancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      onSubmit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }
}

function useFocusOnOpen<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => ref.current?.focus(), [])
  return ref
}

/** The commit message for every change Review shows, drafted or typed. */
export function ReviewCommitBox(props: {
  message: string
  fileCount: number
  generating: boolean
  copied: boolean
  committing: boolean
  /** Why committing has to wait, such as the chat's turn still running. */
  blocked?: string | undefined
  disabled: boolean
  onMessageChange: (message: string) => void
  onGenerate: () => void
  onCopy: () => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFocusOnOpen<HTMLTextAreaElement>()
  const ready = props.message.trim().length > 0 && !props.disabled && !props.blocked
  const submit = () => {
    if (ready) props.onCommit()
  }

  return (
    <form
      className="workspace-review__composer"
      aria-label="Commit changes"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={field}
        className="workspace-review__field is-mono"
        value={props.message}
        placeholder="Commit message"
        aria-label="Commit message"
        spellCheck
        readOnly={props.generating}
        onChange={(event) => props.onMessageChange(event.target.value)}
        onKeyDown={composerKeys(submit, props.onCancel)}
      />
      <div className="workspace-review__composer-actions">
        <button
          type="button"
          className="workspace-review__quiet"
          aria-label="Draft commit message"
          title="Draft a message from these changes with the background model"
          disabled={props.generating || props.disabled}
          onClick={props.onGenerate}
        >
          <IconMorph active={props.generating ? 1 : 0}>
            <Sparkles size={14} aria-hidden />
            <LoaderCircle className="spinner" size={14} aria-hidden />
          </IconMorph>
          <span>Draft</span>
        </button>
        <button
          type="button"
          className="workspace-review__quiet is-icon"
          aria-label="Copy commit message"
          title="Copy commit message"
          disabled={!props.message}
          onClick={props.onCopy}
        >
          <IconMorph active={props.copied ? 1 : 0}>
            <Copy size={14} aria-hidden />
            <Check size={14} aria-hidden />
          </IconMorph>
        </button>
        <span className="workspace-review__composer-spacer" />
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn workspace-review__submit"
          disabled={!ready}
          title={props.blocked ?? `Commit (${SUBMIT_KEY})`}
        >
          {props.committing ? <LoaderCircle className="spinner" size={14} aria-hidden /> : null}
          Commit {props.fileCount} {props.fileCount === 1 ? 'file' : 'files'}
        </button>
      </div>
    </form>
  )
}
