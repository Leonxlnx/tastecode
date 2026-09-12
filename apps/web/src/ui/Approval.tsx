import { useEffect, useRef } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@harness/contracts'
import { IconShieldExclamation as ShieldAlert } from '@tabler/icons-react'

/**
 * The agent asking permission.
 *
 * This is the highest-privilege moment in the app — answering yes authorises
 * arbitrary execution or a write to disk — so it is designed against being
 * dismissed on autopilot:
 *
 * - The exact command and working directory are shown, never a paraphrase.
 * - Approve is not focused by default. A held-down Enter must not answer it.
 * - The reason is the agent's own words, quoted as theirs rather than ours.
 * - Nothing times out into a yes. Codex blocks until answered, and so do we.
 */
export function Approval(props: {
  request: ApprovalRequest
  onDecide: (decision: ApprovalDecision) => void
}) {
  const card = useRef<HTMLDivElement>(null)

  // Scroll it into view. An unanswered prompt off-screen looks like a hang.
  useEffect(() => {
    card.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  return (
    <div className="approval" ref={card} role="alertdialog" aria-label="Permission needed">
      <div className="approval__head">
        <ShieldAlert size={14} aria-hidden />
        <span className="approval__title">{title(props.request)}</span>
      </div>

      {props.request.command ? (
        <pre className="approval__command">{props.request.command}</pre>
      ) : null}

      {props.request.path ? <p className="approval__path">{props.request.path}</p> : null}

      {props.request.cwd ? (
        <p className="approval__meta">
          in <span className="approval__cwd">{props.request.cwd}</span>
        </p>
      ) : null}

      {props.request.reason ? (
        <blockquote className="approval__reason">{props.request.reason}</blockquote>
      ) : null}

      <div className="approval__actions">
        <button className="btn btn--quiet" onClick={() => props.onDecide('deny')}>
          Deny
        </button>
        <button className="approval__secondary-action" onClick={() => props.onDecide('abort')}>
          Stop the turn
        </button>
        <span className="approval__spacer" />
        <button
          className="approval__secondary-action"
          onClick={() => props.onDecide('approve-session')}
        >
          Always this session
        </button>
        <button className="btn" onClick={() => props.onDecide('approve')}>
          Allow once
        </button>
      </div>
    </div>
  )
}

function title(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return 'Run this command?'
    case 'file_change':
      return 'Write to your files?'
    case 'permissions':
      return 'Grant extra access?'
  }
}
