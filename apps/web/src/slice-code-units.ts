/** A code-unit slice must not end on a high surrogate, or the cut splits an emoji. */
export function sliceCodeUnits(text: string, limit: number): string {
  const cut = text.slice(0, limit)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}
