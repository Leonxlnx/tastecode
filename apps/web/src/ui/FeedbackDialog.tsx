import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FEEDBACK_MESSAGE_MAX,
  type FeedbackDraft,
  type FeedbackKind,
  type FeedbackPreview,
} from '@harness/contracts'
import { IconChevronRight, IconLoader2, IconX } from '@tabler/icons-react'
import type { FeedbackRequest, FeedbackState } from '../feedback-state.js'
import { IndeterminateRequestError, type Transport } from '../transport.js'
import { useDialogFocus } from './dialog-focus.js'
import '../styles/feedback.css'

const KINDS: ReadonlyArray<{ id: FeedbackKind; label: string }> = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'question', label: 'Question' },
  { id: 'praise', label: 'Praise' },
  { id: 'other', label: 'Other' },
]
const COUNTER_FROM = FEEDBACK_MESSAGE_MAX - 500
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PREVIEW_DELAY_MS = 300

function waitLabel(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  return seconds < 90 ? `Wait ${seconds} s` : `Wait ${Math.ceil(seconds / 60)} min`
}

/**
 * Nothing leaves the machine until Send. The server builds and redacts the
 * payload, and the disclosure shows that exact text, so what the user reads
 * is what the inbox receives.
 */
export function FeedbackDialog(props: {
  transport: Transport
  request: FeedbackRequest
  status: FeedbackState
  onSent: () => void
  onStatusChange: () => void
  onClose: () => void
}) {
  const dialog = useDialogFocus<HTMLDivElement>(props.onClose)
  const titleId = useId()
  const messageId = useId()
  const emailId = useId()
  const emailHintId = useId()
  const payloadId = useId()
  const error = props.request.context.error
  const [kind, setKind] = useState<FeedbackKind>(props.request.kind ?? (error ? 'bug' : 'other'))
  const [message, setMessage] = useState(props.request.message ?? '')
  const [email, setEmail] = useState('')
  const [includeError, setIncludeError] = useState(error !== undefined)
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [showPayload, setShowPayload] = useState(false)
  const [preview, setPreview] = useState<FeedbackPreview>()
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [submitWaitUntil, setWaitUntil] = useState(0)
  const [openedAt] = useState(() => Date.now())
  const [now, setNow] = useState(openedAt)
  const statusWaitUntil = props.status.retryAfterMs
    ? (props.status.receivedAt ?? openedAt) + props.status.retryAfterMs
    : 0
  const waitUntil = Math.max(statusWaitUntil, submitWaitUntil)
  const submissionId = useRef<string | undefined>(undefined)
  const sendingRef = useRef(false)

  const trimmedEmail = email.trim()
  const draft = useMemo<FeedbackDraft>(
    () => ({
      kind,
      message,
      ...(trimmedEmail ? { email: trimmedEmail } : {}),
      includeError,
      includeDiagnostics,
      context: { ...props.request.context, source: props.request.source },
    }),
    [kind, message, trimmedEmail, includeError, includeDiagnostics, props.request],
  )

  // A new draft is a new submission; a resend of the same one keeps its id.
  useEffect(() => {
    submissionId.current = undefined
  }, [draft])

  useEffect(() => {
    if (!showPayload) return
    let current = true
    const timer = window.setTimeout(() => {
      props.transport.request('feedback.preview', draft).then(
        (next) => {
          if (current) setPreview(next)
        },
        () => {
          if (current) setPreview(undefined)
        },
      )
    }, PREVIEW_DELAY_MS)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [draft, showPayload, props.transport])

  const waiting = waitUntil > now
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waiting])

  const paused = props.status.reason === 'paused'
  const emailValid = trimmedEmail === '' || EMAIL.test(trimmedEmail)
  const hasContent = message.trim() !== '' || (includeError && error !== undefined)
  const canSend = hasContent && emailValid && !sending && !waiting

  const send = async () => {
    if (!canSend || sendingRef.current) return
    sendingRef.current = true
    submissionId.current ??= crypto.randomUUID()
    setSending(true)
    setFailure(undefined)
    try {
      const result = await props.transport.request('feedback.submit', {
        ...draft,
        submissionId: submissionId.current,
      })
      submissionId.current = undefined
      if (result.ok) {
        props.onSent()
        return
      }
      setFailure(result.message)
      if (result.retryAfterMs) {
        setNow(Date.now())
        setWaitUntil(Date.now() + result.retryAfterMs)
      }
    } catch (reason) {
      // A lost reply may still have been delivered; the same id asks again safely.
      if (!(reason instanceof IndeterminateRequestError)) submissionId.current = undefined
      setFailure("Couldn't reach TasteCode's local server. Your text is still here.")
    } finally {
      sendingRef.current = false
      setSending(false)
      props.onStatusChange()
    }
  }

  const title = props.request.source === 'error_report' ? 'Report a problem' : 'Send feedback'
  const placeholder =
    kind === 'bug' ? 'What happened? What did you expect?' : "What's on your mind?"
  const sendLabel = sending ? 'Sending…' : waiting ? waitLabel(waitUntil - now) : 'Send'

  return createPortal(
    <div
      className="sheet"
      role="presentation"
      onKeyDown={(event) => {
        dialog.onKeyDown(event)
        if (!event.defaultPrevented && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          void send()
        }
      }}
    >
      <button
        className="sheet__scrim"
        type="button"
        tabIndex={-1}
        onClick={props.onClose}
        aria-label="Close feedback"
      />
      <div
        className="sheet__panel feedback"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog.panel}
        tabIndex={-1}
      >
        <header className="feedback__head">
          <h2 className="feedback__title" id={titleId}>
            {title}
          </h2>
          <button
            className="feedback__close"
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            title="Close"
          >
            <IconX size={14} aria-hidden />
          </button>
        </header>

        <div className="feedback__kinds" role="radiogroup" aria-label="Kind of feedback">
          {KINDS.map((entry) => (
            <label key={entry.id} className={`feedback__kind${kind === entry.id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name={`${titleId}-kind`}
                value={entry.id}
                checked={kind === entry.id}
                onChange={() => setKind(entry.id)}
              />
              {entry.label}
            </label>
          ))}
        </div>

        <label className="feedback__label" htmlFor={messageId}>
          {error && includeError ? 'Add a note (optional)' : 'Message'}
        </label>
        <textarea
          id={messageId}
          className="feedback__message"
          value={message}
          maxLength={FEEDBACK_MESSAGE_MAX}
          placeholder={placeholder}
          rows={5}
          autoFocus
          onChange={(event) => setMessage(event.target.value)}
        />
        {message.length >= COUNTER_FROM ? (
          <p className="feedback__counter" aria-live="polite">
            {message.length} / {FEEDBACK_MESSAGE_MAX}
          </p>
        ) : null}

        <label className="feedback__label" htmlFor={emailId}>
          Email <span>(optional)</span>
        </label>
        <input
          id={emailId}
          className="feedback__email"
          type="email"
          value={email}
          maxLength={254}
          autoComplete="email"
          placeholder="Only if you want a reply"
          aria-invalid={!emailValid || undefined}
          aria-describedby={!emailValid ? emailHintId : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
        {!emailValid ? (
          <p className="feedback__hint" id={emailHintId}>
            Enter a full email address, or leave it empty.
          </p>
        ) : null}

        <div className="feedback__options">
          {error ? (
            <FeedbackToggle
              label="Include the error message"
              note="The error TasteCode showed, with file paths and secrets removed."
              checked={includeError}
              onChange={setIncludeError}
            />
          ) : null}
          <FeedbackToggle
            label="Include app details"
            note="TasteCode version, OS, provider and model. No prompts, files or paths."
            checked={includeDiagnostics}
            onChange={setIncludeDiagnostics}
          />
        </div>

        <button
          className="feedback__disclosure"
          type="button"
          aria-expanded={showPayload}
          aria-controls={payloadId}
          onClick={() => setShowPayload((open) => !open)}
        >
          <IconChevronRight size={13} aria-hidden />
          Show exactly what will be sent
        </button>
        {showPayload ? (
          <div className="feedback__payload" id={payloadId}>
            {preview?.payload ? (
              <pre tabIndex={0} aria-label="Feedback payload">
                {preview.payload}
              </pre>
            ) : (
              <p className="feedback__payload-empty">
                {hasContent ? 'Preparing preview…' : 'Nothing to send yet.'}
              </p>
            )}
            {preview && preview.redactions > 0 ? (
              <p className="feedback__redactions">
                {preview.redactions === 1
                  ? '1 item was redacted.'
                  : `${preview.redactions} items were redacted.`}
              </p>
            ) : null}
          </div>
        ) : null}

        {failure || paused ? (
          <p className="feedback__failure" role="alert">
            {failure ?? 'Feedback is paused right now. Try again later.'}
          </p>
        ) : null}

        <footer className="feedback__foot">
          <p className="feedback__where">Goes to the TasteCode team's feedback inbox.</p>
          <div className="feedback__actions">
            <button className="feedback__cancel" type="button" onClick={props.onClose}>
              Cancel
            </button>
            <button
              className="feedback__send"
              type="button"
              disabled={!canSend}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onClick={() => void send()}
            >
              {sending ? <IconLoader2 className="spinner" size={13} aria-hidden /> : null}
              {sendLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function FeedbackToggle(props: {
  label: string
  note: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const labelId = useId()
  const noteId = useId()
  return (
    <div className="feedback__toggle">
      <span className="feedback__toggle-text">
        <span id={labelId}>{props.label}</span>
        <small id={noteId}>{props.note}</small>
      </span>
      <button
        className={`switch${props.checked ? ' is-on' : ''}`}
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-labelledby={labelId}
        aria-describedby={noteId}
        onClick={() => props.onChange(!props.checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  )
}
