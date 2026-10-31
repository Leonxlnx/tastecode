import { useCallback, useState } from 'react'
import type { ApprovalDecision, Subagent } from '@harness/contracts'
import { IconChevronLeft as ChevronLeft, IconSquare as Square } from '@tabler/icons-react'
import { providerDisplayName } from '../../provider-presentation.js'
import type { Transport } from '../../transport.js'
import { SubagentStatus } from '../SubagentRow.js'
import { Thread } from '../Thread.js'
import type { AgentEntry } from './agents-list.js'
import { useChildTranscript } from './child-transcript.js'

/**
 * One sub-agent, opened from the Agents tab. A sub-agent TasteCode started
 * shows its own chat, read-only, where its approvals and questions can be
 * answered and its run stopped. One the engine runs itself shows its last
 * snapshot: the engine keeps no transcript TasteCode can read yet.
 */
export function AgentDetail(props: {
  entry: AgentEntry
  active: boolean
  transport: Transport
  onBack: () => void
}) {
  const { entry, transport } = props
  const { subagent } = entry
  const childId = subagent.threadId
  const running = subagent.state === 'running'
  const engine = subagent.provider
    ? [providerDisplayName(subagent.provider), subagent.model].filter(Boolean).join(' · ')
    : undefined
  const [stop, setStop] = useState<{ pending: boolean; error?: string }>({ pending: false })

  const stopRun = () => {
    if (!childId) return
    setStop({ pending: true })
    transport
      .request('thread.interrupt', { threadId: childId })
      .then(() => setStop({ pending: false }))
      .catch((error: unknown) =>
        setStop({
          pending: false,
          error: error instanceof Error ? error.message : 'Could not stop it.',
        }),
      )
  }

  return (
    <div className="agent-detail">
      <header className="agent-detail__head">
        <button
          type="button"
          className="agent-detail__back"
          aria-label="All subagents"
          title="All subagents"
          onClick={props.onBack}
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
        <span className="agent-detail__title">
          <span className="agent-detail__name">{subagent.name ?? 'Subagent'}</span>
          {engine ? <span className="agent-detail__engine">{engine}</span> : null}
        </span>
        {running && childId ? (
          <button
            type="button"
            className="agent-detail__stop"
            disabled={stop.pending}
            onClick={stopRun}
          >
            <Square size={10} aria-hidden />
            {stop.pending ? 'Stopping…' : 'Stop'}
          </button>
        ) : null}
      </header>
      <div className="agent-detail__status">
        <SubagentStatus subagent={subagent} startedAt={entry.createdAt} />
        {stop.error ? (
          <span className="agent-detail__error" role="alert">
            {stop.error}
          </span>
        ) : null}
      </div>
      {childId ? (
        props.active ? (
          <ChildThread key={childId} threadId={childId} transport={transport} />
        ) : null
      ) : (
        <SnapshotDetail subagent={subagent} />
      )}
    </div>
  )
}

function ChildThread({ threadId, transport }: { threadId: string; transport: Transport }) {
  const transcript = useChildTranscript(transport, threadId)
  const decide = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      void transport
        .request('thread.respondToApproval', { threadId, approvalId, decision })
        .catch(() => undefined)
    },
    [threadId, transport],
  )
  const answer = useCallback(
    async (requestId: string, answers: Record<string, string[]>) => {
      await transport.request('thread.respondToUserInput', { threadId, requestId, answers })
    },
    [threadId, transport],
  )
  return (
    <div className="agent-detail__transcript">
      <Thread
        frameStore={transcript.frameStore}
        threadId={threadId}
        transport={transport}
        keyboardActive={false}
        loading={transcript.loading}
        loadFailure={transcript.failure}
        onRetryLoad={transcript.retry}
        onDecide={decide}
        onAnswerUserInput={answer}
        inlineUserInput
      />
    </div>
  )
}

/** What the parent's row knows; the whole story for a sub-agent without a chat of its own. */
function SnapshotDetail({ subagent }: { subagent: Subagent }) {
  const running = subagent.state === 'running'
  // A TasteCode sub-agent gets its chat once it starts; one that never started has none.
  const note = subagent.provider
    ? running
      ? 'Its transcript shows here once it starts.'
      : undefined
    : 'Transcript not available for this engine yet'
  return (
    <div className="agent-detail__snapshot">
      {subagent.description ? (
        <section className="agent-detail__section">
          <h4 className="agent-detail__label">Task</h4>
          <p className="agent-detail__text">{subagent.description}</p>
        </section>
      ) : null}
      {running && subagent.lastTool ? (
        <section className="agent-detail__section">
          <h4 className="agent-detail__label">Now</h4>
          <p className="agent-detail__text">{subagent.lastTool}</p>
        </section>
      ) : null}
      {subagent.summary ? (
        <section className="agent-detail__section">
          <h4 className="agent-detail__label">Report</h4>
          <p className="agent-detail__text agent-detail__text--report">{subagent.summary}</p>
        </section>
      ) : null}
      {note ? <p className="agent-detail__note">{note}</p> : null}
    </div>
  )
}
