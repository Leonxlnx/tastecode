export type PullRequestFilterValueCounts = {
  total: number
  byValue: ReadonlyMap<string, number>
}

export function countPullRequestFilterValues<Item>(
  items: readonly Item[],
  matchesOtherFilters: (item: Item) => boolean,
  valueOf: (item: Item) => string,
): PullRequestFilterValueCounts {
  let total = 0
  const byValue = new Map<string, number>()
  for (const item of items) {
    if (!matchesOtherFilters(item)) continue
    total += 1
    const value = valueOf(item)
    if (value.length === 0) continue
    byValue.set(value, (byValue.get(value) ?? 0) + 1)
  }
  return { total, byValue }
}
