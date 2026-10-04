import { bench, describe } from 'vitest'
import { comparePullRequestText } from './pull-requests.js'

const OPTIONS = { iterations: 30, time: 0, warmupIterations: 8, warmupTime: 0 }
const ITEM_COUNT = 1_000
const labels = Array.from(
  { length: ITEM_COUNT },
  (_, index) => `Release ${ITEM_COUNT - index} Alpha ${index % 13}`,
)
let checksum = 0

function sortWithPerComparisonOptions(): void {
  const sorted = [...labels].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' }),
  )
  checksum ^= sorted[0]!.length + sorted.at(-1)!.length
}

function sortWithRetainedCollator(): void {
  const sorted = [...labels].sort(comparePullRequestText)
  checksum ^= sorted[0]!.length + sorted.at(-1)!.length
}

describe('large pull-request metadata ordering', () => {
  bench('creates collation options for each comparison', sortWithPerComparisonOptions, OPTIONS)
  bench('reuses one case-insensitive collator', sortWithRetainedCollator, OPTIONS)
})
