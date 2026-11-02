import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FeedbackDraft,
  FeedbackKind,
  FeedbackSource,
  FeedbackStatus,
} from '@harness/contracts'
import type { Transport } from './transport.js'

/** What opens the feedback dialog. Context is gathered by the app at that moment. */
export type FeedbackRequest = {
  source: FeedbackSource
  kind?: FeedbackKind
  message?: string
  context: Omit<FeedbackDraft['context'], 'source'>
  /** Bumped per open, so reopening from the same place starts a fresh draft. */
  id: number
}

export const FEEDBACK_SENT_NOTICE = 'Sent. Thanks!'

/** The server's answer and when it arrived, so a wait counts down from the right moment. */
export type FeedbackState = FeedbackStatus & { receivedAt?: number }

const DISABLED: FeedbackState = { enabled: false, reason: 'not_configured' }

/**
 * Whether this build can send feedback. Asked once per connection, and again
 * after each submission. A server that predates feedback answers "unknown
 * method", which reads as disabled, and so does any other failure: the entry
 * points stay hidden rather than offering something that cannot work.
 */
export function useFeedbackStatus(transport: Transport) {
  const [status, setStatus] = useState<FeedbackState>(DISABLED)
  const generation = useRef(0)
  const refresh = useCallback(() => {
    const request = ++generation.current
    const settle = (next: FeedbackState) => {
      if (request !== generation.current) return
      // An unchanged answer keeps the same object, so the app does not re-render.
      setStatus((current) => (sameStatus(current, next) ? current : next))
    }
    transport.request('feedback.status', {}).then(
      (next) =>
        settle(
          typeof next?.enabled !== 'boolean'
            ? DISABLED
            : next.retryAfterMs
              ? { ...next, receivedAt: Date.now() }
              : next,
        ),
      () => settle(DISABLED),
    )
  }, [transport])

  useEffect(() => {
    if (transport.state === 'open') refresh()
    return transport.onState((state) => {
      if (state === 'open') refresh()
    })
  }, [transport, refresh])

  return { status, refresh } as const
}

function sameStatus(a: FeedbackState, b: FeedbackState): boolean {
  return (
    a.enabled === b.enabled &&
    a.reason === b.reason &&
    a.retryAfterMs === undefined &&
    b.retryAfterMs === undefined
  )
}
