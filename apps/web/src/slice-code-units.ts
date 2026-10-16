/** A code-unit slice must not end on a high surrogate, or the cut splits an emoji. */
export function sliceCodeUnits(text: string, limit: number): string {
  const cut = text.slice(0, limit)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

export const CHECKPOINT_LABEL_UNITS = 60

export function checkpointLabel(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= CHECKPOINT_LABEL_UNITS) return trimmed || 'Turn'
  const cut = sliceCodeUnits(trimmed, CHECKPOINT_LABEL_UNITS).trimEnd()
  return cut ? `${cut}…` : 'Turn'
}
