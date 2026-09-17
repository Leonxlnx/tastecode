import type { DomainEvent, ProviderHistorySession, Turn } from '@harness/contracts'
import { object, timestamp } from './history-values.js'
import { historyItem, responseItem, type HistoryItem } from './history-items.js'

type RecordValue = Record<string, unknown>
type Entry = {
  payload: RecordValue
  index: number
  createdAt: number
  kind: 'rich' | 'response' | 'event'
}
type SavedTurn = {
  id: string
  createdAt: number
  completedAt?: number
  status?: 'completed' | 'failed' | 'interrupted'
  entries: Entry[]
}

/** Native lifecycle items take precedence over their wire/event echoes. */
export function parseCodexHistory(
  records: RecordValue[],
  session: ProviderHistorySession,
): DomainEvent[] {
  const turns: SavedTurn[] = []
  const nativeTurns = new Map<string, SavedTurn>()
  let current: SavedTurn | undefined
  function turn(id: unknown, createdAt: number): SavedTurn {
    const nativeId = typeof id === 'string' ? id : undefined
    const existing = nativeId ? nativeTurns.get(nativeId) : undefined
    if (existing) {
      current = existing
      return current
    }
    if (current && !nativeId) return current
    if (current && !current.status) {
      if (nativeId && current.id.startsWith(`${session.id}:turn:`)) {
        current.id = nativeId
        nativeTurns.set(nativeId, current)
      }
      if (!nativeId || current.id === nativeId) return current
    }
    current = { id: nativeId ?? `${session.id}:turn:${turns.length}`, createdAt, entries: [] }
    if (nativeId) nativeTurns.set(nativeId, current)
    turns.push(current)
    return current
  }

  records.forEach((record, index) => {
    const payload = object(record.payload)
    const createdAt = timestamp(record.timestamp, session.createdAt)
    if (
      record.type === 'turn_context' ||
      (record.type === 'event_msg' && payload.type === 'task_started')
    ) {
      turn(payload.turn_id, timestamp(payload.started_at, createdAt))
      return
    }
    if (
      record.type === 'event_msg' &&
      ['task_complete', 'turn_aborted', 'task_failed'].includes(String(payload.type))
    ) {
      const active = turn(payload.turn_id, createdAt)
      active.status =
        payload.type === 'turn_aborted'
          ? 'interrupted'
          : payload.type === 'task_failed'
            ? 'failed'
            : 'completed'
      active.completedAt = timestamp(payload.completed_at, createdAt)
      return
    }
    const kind =
      record.type === 'response_item'
        ? 'response'
        : record.type === 'event_msg'
          ? payload.type === 'item_completed'
            ? 'rich'
            : ['user_message', 'agent_message', 'agent_reasoning'].includes(String(payload.type))
              ? 'event'
              : undefined
          : undefined
    if (!kind) return
    if (
      kind === 'response' &&
      payload.type === 'message' &&
      payload.role !== 'user' &&
      payload.role !== 'assistant'
    )
      return
    const entry = kind === 'rich' ? object(payload.item) : payload
    if (
      current?.status &&
      kind !== 'rich' &&
      (payload.type === 'user_message' || (payload.type === 'message' && payload.role === 'user'))
    )
      current = undefined
    turn(kind === 'rich' ? payload.turn_id : undefined, createdAt).entries.push({
      payload: entry,
      index,
      kind,
      createdAt: timestamp(payload.started_at_ms, createdAt),
    })
  })

  const events: DomainEvent[] = [
    {
      type: 'thread.started',
      thread: {
        id: session.id,
        provider: 'codex',
        workspacePath: session.workspacePath,
        title: session.title,
        createdAt: session.createdAt,
      },
    },
  ]
  for (const saved of turns) {
    const items = turnItems(saved)
    if (items.length === 0) continue
    const status = saved.status ?? 'interrupted'
    const mapped: Turn = {
      id: saved.id,
      threadId: session.id,
      status: 'running',
      createdAt: saved.createdAt,
    }
    events.push({ type: 'turn.started', turn: mapped })
    const diffs: string[] = []
    for (const { item, diff } of items) {
      events.push({ type: 'item.completed', item })
      if (diff) diffs.push(diff)
    }
    if (diffs.length)
      events.push({ type: 'diff.updated', turnId: saved.id, diff: diffs.join('\n') })
    events.push({
      type: 'turn.completed',
      turnId: saved.id,
      status,
      ...(saved.completedAt === undefined ? {} : { completedAt: saved.completedAt }),
    })
  }
  return events
}

function turnItems(turn: SavedTurn): HistoryItem[] {
  const mapped: Array<HistoryItem & { kind: Entry['kind']; index: number }> = []
  const richIds = new Set(
    turn.entries
      .filter((entry) => entry.kind === 'rich')
      .map((entry) => entry.payload.id)
      .filter((id) => typeof id === 'string'),
  )
  const outputs = new Map(
    turn.entries
      .filter(
        (entry) => entry.kind === 'response' && String(entry.payload.type).endsWith('_output'),
      )
      .map((entry) => [entry.payload.call_id, entry.payload.output]),
  )
  const userKind = turn.entries.some(
    (entry) => entry.kind === 'rich' && entry.payload.type === 'UserMessage',
  )
    ? 'rich'
    : turn.entries.some((entry) => entry.kind === 'event' && entry.payload.type === 'user_message')
      ? 'event'
      : 'response'

  for (const entry of turn.entries) {
    const base = {
      id:
        typeof entry.payload.id === 'string' ? entry.payload.id : `${turn.id}:item:${entry.index}`,
      turnId: turn.id,
      createdAt: entry.createdAt,
      status: 'completed' as const,
    }
    let items: HistoryItem[]
    if (entry.kind === 'rich') items = historyItem(entry.payload, base)
    else if (entry.kind === 'response') {
      if (
        (typeof entry.payload.id === 'string' && richIds.has(entry.payload.id)) ||
        (typeof entry.payload.call_id === 'string' && richIds.has(entry.payload.call_id))
      )
        continue
      items = responseItem(entry.payload, base, outputs.get(entry.payload.call_id))
    } else {
      const user = entry.payload.type === 'user_message'
      const reasoning = entry.payload.type === 'agent_reasoning'
      const attachments = [
        entry.payload.local_images,
        entry.payload.images,
        entry.payload.local_audio,
      ].flatMap((value) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [],
      )
      items = [
        {
          item: {
            ...base,
            type: reasoning ? 'reasoning' : 'message',
            ...(reasoning ? {} : { role: user ? 'user' : 'assistant' }),
            ...(entry.payload.phase === 'commentary' || entry.payload.phase === 'final_answer'
              ? { phase: entry.payload.phase }
              : {}),
            text: String(entry.payload.message ?? entry.payload.text ?? ''),
            ...(attachments.length ? { attachments } : {}),
          },
        },
      ]
    }
    for (const result of items) {
      if (result.item.role === 'user' && entry.kind !== userKind) continue
      mapped.push({ ...result, kind: entry.kind, index: entry.index })
    }
  }

  // Match duplicate occurrences across sources, while preserving repeated messages within one source.
  const ranks = { rich: 0, response: 1, event: 2 }
  const counts = new Map<string, number>()
  const accepted: typeof mapped = []
  const acceptedByContent = new Map<string, typeof mapped>()
  for (const kind of ['rich', 'response', 'event'] as const) {
    const occurrences = new Map<string, number>()
    for (const result of mapped.filter((entry) => entry.kind === kind)) {
      const { item } = result
      const dedup = item.type === 'message' || item.type === 'reasoning'
      const key = `${item.type}:${item.role ?? ''}:${item.text ?? ''}`
      const occurrence = (occurrences.get(key) ?? 0) + 1
      occurrences.set(key, occurrence)
      if (dedup && occurrence <= (counts.get(key) ?? 0)) {
        const original = acceptedByContent.get(key)?.[occurrence - 1]
        if (original) original.index = Math.min(original.index, result.index)
        continue
      }
      accepted.push(result)
      const byContent = acceptedByContent.get(key) ?? []
      byContent.push(result)
      acceptedByContent.set(key, byContent)
    }
    for (const [key, count] of occurrences) counts.set(key, Math.max(counts.get(key) ?? 0, count))
  }
  const byId = new Map<string, (typeof mapped)[number]>()
  for (const entry of accepted) {
    const previous = byId.get(entry.item.id)
    if (!previous || ranks[entry.kind] <= ranks[previous.kind]) {
      byId.set(entry.item.id, {
        ...entry,
        index: Math.min(previous?.index ?? entry.index, entry.index),
      })
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ item, diff }) => {
      return { item, ...(diff ? { diff } : {}) }
    })
}
