import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ThreadSubagent } from '@harness/contracts'
import { providerDisplayName } from '../../provider-presentation.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'
import type { Transport } from '../../transport.js'
import { SubagentGlyph, SubagentStatus } from '../SubagentRow.js'
import { groupAgentEntries, subagentEntries, type AgentEntry } from './agents-list.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'
import './workspace-agents.css'

const NO_LISTED: readonly ThreadSubagent[] = []
const noSubscription = () => () => {}
/** Stands in when no transcript is passed, such as in a panel without a chat. */
const NO_TRANSCRIPT = new ThreadFrameStore(emptyThread)

/**
 * The chat's sub-agents, the engine's own and the ones TasteCode started on
 * another provider. Rows come from the transcript's structural snapshot, which
 * changes at item boundaries only, plus `thread.subagents` for rows on pages
 * the transcript has not loaded. A hidden tab neither subscribes nor asks.
 */
export function WorkspaceAgents(props: {
  active: boolean
  transport: Transport
  threadId?: string | undefined
  frameStore?: ThreadFrameStore | undefined
}) {
  const { active, transport, threadId } = props
  const frameStore = props.frameStore ?? NO_TRANSCRIPT
  const subscribe = active ? frameStore.subscribeStructure : noSubscription
  const thread = useSyncExternalStore(subscribe, frameStore.getStructureSnapshot)
  const fromItems = useMemo(() => subagentEntries(thread.items), [thread.items])
  const [listed, setListed] = useState<{
    threadId: string
    subagents: readonly ThreadSubagent[]
  }>()

  useEffect(() => {
    if (!active || !threadId) return
    let current = true
    transport
      .request('thread.subagents', { threadId })
      .then((result) => {
        if (current) setListed({ threadId, subagents: result.subagents })
      })
      // An older server does not know the method; the transcript's rows still show.
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [active, threadId, transport])

  const groups = useMemo(
    () =>
      groupAgentEntries(
        fromItems,
        listed && listed.threadId === threadId ? listed.subagents : NO_LISTED,
      ),
    [fromItems, listed, threadId],
  )

  if (!threadId) {
    return (
      <WorkspaceEmptyState
        kind="agents"
        title="No chat open"
        detail="Open a chat to see the subagents it starts."
      />
    )
  }
  if (groups.running.length === 0 && groups.finished.length === 0) {
    return (
      <WorkspaceEmptyState
        kind="agents"
        title="No subagents in this chat yet"
        detail="When the agent hands part of the work to a helper, on its own engine or another one, it shows up here."
      />
    )
  }
  return (
    <div className="workspace-agents">
      <AgentGroup label="Running" entries={groups.running} />
      <AgentGroup label="Finished" entries={groups.finished} />
    </div>
  )
}

function AgentGroup({ label, entries }: { label: string; entries: readonly AgentEntry[] }) {
  if (entries.length === 0) return null
  return (
    <section className="agents-group" aria-label={label}>
      <h3 className="agents-group__label">
        {label}
        <span className="agents-group__count">{entries.length}</span>
      </h3>
      <ul className="agents-group__list">
        {entries.map((entry) => (
          <AgentRow key={entry.itemId} entry={entry} />
        ))}
      </ul>
    </section>
  )
}

function AgentRow({ entry }: { entry: AgentEntry }) {
  const { subagent } = entry
  const running = subagent.state === 'running'
  const engine = subagent.provider
    ? [providerDisplayName(subagent.provider), subagent.model].filter(Boolean).join(' · ')
    : undefined
  const detail = [engine, subagent.description && oneLine(subagent.description)]
    .filter(Boolean)
    .join(' · ')
  const attention =
    running && subagent.attention === 'approval'
      ? 'Needs approval'
      : running && subagent.attention === 'input'
        ? 'Needs input'
        : undefined
  return (
    <li className="agents-row" data-state={subagent.state}>
      <span className="agents-row__lead" aria-hidden>
        {running ? <span className="subagent__pulse" /> : <SubagentGlyph />}
      </span>
      <span className="agents-row__text">
        <span className="agents-row__name">{subagent.name ?? 'Subagent'}</span>
        {detail ? <span className="agents-row__detail">{detail}</span> : null}
      </span>
      <span className="agents-row__meta">
        {attention ? <span className="agents-row__attention">{attention}</span> : null}
        <SubagentStatus subagent={subagent} startedAt={entry.createdAt} quietRunning />
      </span>
    </li>
  )
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
