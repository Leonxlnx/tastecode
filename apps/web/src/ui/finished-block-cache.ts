import type { BlockSplitter } from './markdown-blocks.js'

// Charge both the key and the block strings as UTF-16, plus room for map entries,
// string headers and array slots. The budget covers all conversations in this renderer.
export function createFinishedBlockCache(budget = 2 * 1024 * 1024) {
  const entries = new Map<string, { blocks: string[]; bytes: number }>()
  let used = 0

  return (text: string, split: BlockSplitter): string[] => {
    const hit = entries.get(text)
    if (hit) {
      entries.delete(text)
      entries.set(text, hit)
      return hit.blocks
    }
    const blocks = split(text)
    let bytes = 128 + 2 * text.length
    if (bytes > budget) return blocks
    for (const block of blocks) {
      bytes += 64 + 2 * block.length
      if (bytes > budget) return blocks
    }
    while (used + bytes > budget) {
      const oldest = entries.keys().next().value!
      used -= entries.get(oldest)!.bytes
      entries.delete(oldest)
    }
    entries.set(text, { blocks, bytes })
    used += bytes
    return blocks
  }
}

export const finishedBlocks = createFinishedBlockCache()
