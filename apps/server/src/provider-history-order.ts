import type { DomainEvent } from '@harness/contracts'

type Entry = { seq: number; event: DomainEvent }

/** Provider turns may predate local ones even though they were discovered later. */
export function orderProviderHistory(entries: Entry[]): Entry[] {
  if (
    !entries.some(
      ({ event }) => event.type === 'turn.started' && event.turn.id.startsWith('import:'),
    )
  )
    return entries
  const groups = new Map<string, { at: number; entries: Entry[] }>()
  const leading: Entry[] = []
  let current: string | undefined
  for (const entry of entries) {
    const event = entry.event
    const id =
      event.type === 'turn.started'
        ? event.turn.id
        : event.type === 'item.started' || event.type === 'item.completed'
          ? event.item.turnId
          : 'turnId' in event
            ? event.turnId
            : undefined
    if (id) current = id
    if (event.type === 'thread.started' || !current) {
      leading.push(entry)
      continue
    }
    let group = groups.get(current)
    if (!group) {
      group = { at: Number.MAX_SAFE_INTEGER, entries: [] }
      groups.set(current, group)
    }
    if (event.type === 'turn.started') group.at = event.turn.createdAt
    else if (
      group.at === Number.MAX_SAFE_INTEGER &&
      (event.type === 'item.completed' || event.type === 'item.started')
    )
      group.at = event.item.createdAt
    group.entries.push(entry)
  }
  const result = [
    ...leading,
    ...[...groups.values()].sort((a, b) => a.at - b.at).flatMap((group) => group.entries),
  ]
  // The tail remains the durable watermark even when display order differs.
  const last = result.at(-1)
  if (last)
    result[result.length - 1] = {
      ...last,
      seq: entries.reduce((max, entry) => Math.max(max, entry.seq), 0),
    }
  return result
}
