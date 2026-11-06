const EFFORT_RANKS = new Map([
  ['none', 0],
  ['minimal', 1],
  ['xlow', 2],
  ['extralow', 2],
  ['low', 3],
  ['medium', 4],
  ['high', 5],
  ['xhigh', 6],
  ['extrahigh', 6],
  ['max', 7],
  ['maximum', 7],
  ['ultra', 8],
])

/** Where an effort name sits from least to most thinking; undefined for a name no engine shares. */
export function reasoningEffortRank(effort: string): number | undefined {
  return EFFORT_RANKS.get(effort.toLowerCase().replace(/[^a-z]/g, ''))
}

/**
 * The effort a model accepts that is nearest the one asked for, the higher one on a tie. An
 * effort the model lists, or a model that lists none, keeps the effort as asked.
 */
export function closestReasoningEffort(
  effort: string | undefined,
  declared: readonly string[],
): string | undefined {
  if (effort === undefined || declared.length === 0 || declared.includes(effort)) return effort
  const wanted = reasoningEffortRank(effort)
  if (wanted === undefined) return effort
  let closest: { effort: string; distance: number; rank: number } | undefined
  for (const candidate of declared) {
    const rank = reasoningEffortRank(candidate)
    if (rank === undefined) continue
    const distance = Math.abs(rank - wanted)
    if (
      !closest ||
      distance < closest.distance ||
      (distance === closest.distance && rank > closest.rank)
    )
      closest = { effort: candidate, distance, rank }
  }
  return closest?.effort ?? effort
}
