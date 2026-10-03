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

type PromptMatches<T> = Map<string, T>
const associations = new WeakMap<object, WeakMap<readonly Item[], PromptMatches<CheckpointEntry>>>()

/** Submission time precedes the asynchronous snapshot. Never borrow an older restore point. */
function followingCheckpoint<T extends CheckpointEntry>(
  item: Item,
  matches: readonly T[],
): T | undefined {
  let low = 0
  let high = matches.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (matches[middle]!.createdAt < item.createdAt) low = middle + 1
    else high = middle
  }
  return matches[low]
}

export function checkpointForItem<T extends CheckpointEntry>(
  item: Item,
  checkpoints: CheckpointIndex<T>,
  items: readonly Item[],
): T | undefined {
  if (checkpoints.size === 0 || item.type !== 'message' || item.role !== 'user') return undefined
  let byItems = associations.get(checkpoints)
  if (!byItems) {
    byItems = new WeakMap()
    associations.set(checkpoints, byItems)
  }
  let matched = byItems.get(items)
  if (!matched) {
    matched = new Map()
    const prompts = new Map<string, Item[]>()
    const turns = new Set<string>()
    for (const prompt of items) {
      if (prompt.type !== 'message' || prompt.role !== 'user' || !prompt.turnId) continue
      if (turns.has(prompt.turnId)) continue
      turns.add(prompt.turnId)
      // Provider-native and imported timestamps do not share submission-time semantics.
      if (!prompt.id.startsWith('local:') || !prompt.text) continue
      const label = prompt.text.trim().slice(0, 60) || 'Turn'
      const group = prompts.get(label) ?? []
      group.push(prompt)
      prompts.set(label, group)
    }
    for (const [label, group] of prompts) {
      const candidates = checkpoints.get(label)
      // Missing pages, retained checkpoint subsets, and failed starts cannot be aligned by count.
      if (!candidates || candidates.length !== group.length) continue
      const used = new Set<T>()
      const pairs: Array<[string, T]> = []
      for (const prompt of group) {
        const candidate = followingCheckpoint(prompt, candidates)
        if (!candidate || used.has(candidate)) break
        used.add(candidate)
        pairs.push([prompt.id, candidate])
      }
      // Queued prompts can precede the same snapshot; do not guess their restore targets.
      if (pairs.length === group.length) {
        for (const [id, checkpoint] of pairs) matched.set(id, checkpoint)
      }
    }
    byItems.set(items, matched)
  }
  return matched.get(item.id) as T | undefined
}
