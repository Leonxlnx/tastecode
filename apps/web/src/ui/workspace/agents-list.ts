import type { Item, Subagent, ThreadSubagent } from '@harness/contracts'

/** One sub-agent as the Agents tab lists it: the parent's row that carries its snapshot. */
export type AgentEntry = { itemId: string; createdAt: number; subagent: Subagent }

export type AgentGroups = { running: AgentEntry[]; finished: AgentEntry[] }

const EMPTY_GROUPS: AgentGroups = { running: [], finished: [] }

/**
 * The sub-agents a transcript shows, native and TasteCode's alike. The caller
 * passes the structural items, whose identity changes at item boundaries only,
 * so this never runs per streamed delta.
 */
export function subagentEntries(items: readonly Item[]): AgentEntry[] {
  const entries: AgentEntry[] = []
  for (const item of items) {
    if (item.subagent) {
      entries.push({ itemId: item.id, createdAt: item.createdAt, subagent: item.subagent })
    }
  }
  return entries
}

/**
 * Running ones above finished ones, newest first in each. A row the
 * transcript holds wins over the listed one, which may be older; the list
 * adds the sub-agents whose rows sit on transcript pages not loaded yet.
 */
export function groupAgentEntries(
  fromItems: readonly AgentEntry[],
  listed: readonly ThreadSubagent[],
): AgentGroups {
  if (fromItems.length === 0 && listed.length === 0) return EMPTY_GROUPS
  const byId = new Map<string, AgentEntry>()
  for (const entry of listed) byId.set(entry.itemId, entry)
  for (const entry of fromItems) byId.set(entry.itemId, entry)
  const newestFirst = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  const groups: AgentGroups = { running: [], finished: [] }
  for (const entry of newestFirst) {
    ;(entry.subagent.state === 'running' ? groups.running : groups.finished).push(entry)
  }
  return groups
}
