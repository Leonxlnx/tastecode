import type { BlockSplitter } from './markdown-blocks.js'

// Rebuild from code units so sliced strings and ropes cannot retain their source.
// Bounded chunks also preserve lone surrogates without exceeding the argument limit.
function ownText(text: string): string {
  const chunks: string[] = []
  for (let start = 0; start < text.length; start += 8192) {
    const units = new Uint16Array(Math.min(8192, text.length - start))
    for (let i = 0; i < units.length; i++) units[i] = text.charCodeAt(start + i)
    chunks.push(String.fromCharCode(...units))
  }
  return chunks.join('')
}

// Charge both the key and the block strings as UTF-16, plus room for map entries,
// string headers and array slots. The budget covers all conversations in this renderer.
export function createFinishedBlockCache(budget = 2 * 1024 * 1024) {
  const entries = new Map<string, { key: string; blocks: string[]; bytes: number }>()
  let used = 0

  return (text: string, split: BlockSplitter): string[] => {
    const hit = entries.get(text)
    if (hit) {
      entries.delete(text)
      entries.set(hit.key, hit)
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
    const key = ownText(text)
    const owned = blocks.map(ownText)
    entries.set(key, { key, blocks: owned, bytes })
    used += bytes
    return owned
  }
}

export const finishedBlocks = createFinishedBlockCache()
