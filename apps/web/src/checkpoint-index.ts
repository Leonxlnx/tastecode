import type { Item } from '@harness/contracts'

export type CheckpointEntry = {
  label: string
  createdAt: number
}

export type CheckpointIndex<T extends CheckpointEntry> = ReadonlyMap<string, readonly T[]>

export function createCheckpointIndex<T extends CheckpointEntry>(
  checkpoints: readonly T[],
): CheckpointIndex<T> {
  const byLabel = new Map<string, T[]>()
  for (const checkpoint of checkpoints) {
    const matches = byLabel.get(checkpoint.label)
    if (matches) matches.push(checkpoint)
    else byLabel.set(checkpoint.label, [checkpoint])
  }
  for (const matches of byLabel.values()) {
    matches.sort((left, right) => left.createdAt - right.createdAt)
  }
  return byLabel
}

export function checkpointForItem<T extends CheckpointEntry>(
  item: Item,
  checkpoints: CheckpointIndex<T>,
): T | undefined {
  if (item.type !== 'message' || item.role !== 'user' || !item.text) return undefined
  const label = item.text.trim().slice(0, 60) || 'Turn'
  const matches = checkpoints.get(label)
  if (!matches) return undefined

  let low = 0
  let high = matches.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (matches[middle]!.createdAt <= item.createdAt) low = middle + 1
    else high = middle
  }
  return matches[low - 1]
}
