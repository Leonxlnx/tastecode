import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ThreadSubagent } from '@harness/contracts'
import { providerDisplayName } from '../../provider-presentation.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'
import type { Transport } from '../../transport.js'
import { SubagentStatus } from '../SubagentRow.js'
import { AgentDetail } from './AgentDetail.js'
import { groupAgentEntries, subagentEntries, type AgentEntry } from './agents-list.js'
import { SubagentAvatar } from './SubagentAvatar.js'
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
  subagentTranscript?: boolean | undefined
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
  /** The row opened to its detail, for the chat it belongs to. */
  const [opened, setOpened] = useState<{ threadId: string; itemId: string }>()
  const closeDetail = useCallback(() => setOpened(undefined), [])

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
  const openEntry =
    opened && opened.threadId === threadId
      ? (groups.running.find((entry) => entry.itemId === opened.itemId) ??
        groups.finished.find((entry) => entry.itemId === opened.itemId))
      : undefined
  if (openEntry) {
    return (
      <AgentDetail
        entry={openEntry}
        active={active}
        transport={transport}
        threadId={threadId}
        subagentTranscript={props.subagentTranscript}
        onBack={closeDetail}
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
  const open = (itemId: string) => setOpened({ threadId, itemId })
  return (
    <div className="workspace-agents">
      <AgentGroup
        label="Active"
        entries={groups.running}
        empty="No active subagents"
        onOpen={open}
      />
      <AgentGroup label="Done" entries={groups.finished} onOpen={open} />
    </div>
  )
}

function AgentGroup({
  label,
  entries,
  empty,
  onOpen,
}: {
  label: string
  entries: readonly AgentEntry[]
  /** Shown instead of the rows; a group without it is left out when empty. */
  empty?: string
  onOpen: (itemId: string) => void
}) {
  if (entries.length === 0 && !empty) return null
  return (
    <section className="agents-group" aria-label={label}>
      <h3 className="agents-group__label">
        {label}
        <span className="agents-group__count">{entries.length}</span>
      </h3>
      {entries.length === 0 ? (
        <p className="agents-group__empty">{empty}</p>
      ) : (
        <ul className="agents-group__list">
          {entries.map((entry) => (
            <li key={entry.itemId}>
              <AgentRow entry={entry} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AgentRow({ entry, onOpen }: { entry: AgentEntry; onOpen: (itemId: string) => void }) {
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
    <button
      type="button"
      className="agents-row"
      data-state={subagent.state}
      onClick={() => onOpen(entry.itemId)}
    >
      <span className="agents-row__lead" aria-hidden>
        <SubagentAvatar seed={entry.itemId} running={running} />
      </span>
      <span className="agents-row__text">
        <span className="agents-row__name">{subagent.name ?? 'Subagent'}</span>
        {detail ? <span className="agents-row__detail">{detail}</span> : null}
      </span>
      <span className="agents-row__meta">
        {attention ? <span className="agents-row__attention">{attention}</span> : null}
        {running ? (
          <SubagentStatus subagent={subagent} startedAt={entry.createdAt} quietRunning />
        ) : (
          <span className="agents-row__when">{finishedLabel(entry, Date.now())}</span>
        )}
      </span>
    </button>
  )
}

/** "Stopped · 1h ago": a finished row says how it ended only when that was not a plain finish. */
export function finishedLabel(entry: AgentEntry, now: number): string {
  const { subagent } = entry
  const endedAt = entry.createdAt + (subagent.durationMs ?? 0)
  const ago = relativeTime(endedAt, now)
  const ending =
    subagent.state === 'failed' ? 'Failed' : subagent.state === 'interrupted' ? 'Stopped' : ''
  return ending ? `${ending} · ${ago}` : ago
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
