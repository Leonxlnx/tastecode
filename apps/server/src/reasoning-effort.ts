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
