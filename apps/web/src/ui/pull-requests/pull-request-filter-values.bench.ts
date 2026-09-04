import { bench, describe } from 'vitest'
import { countPullRequestFilterValues } from './pull-request-filter-values.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const items = Array.from({ length: 10_000 }, (_, index) => ({
  repository: `org/repo-${index % 1_000}`,
  approved: index % 3 === 0,
}))
const values: Array<string | undefined> = [
  undefined,
  ...new Set(items.map((item) => item.repository)),
]

function legacyCounts(): number {
  return values.reduce((checksum, value, index) => {
    const count = items.filter(
      (item) => item.approved && (value === undefined || item.repository === value),
    ).length
    return checksum + count * (index + 1)
  }, 0)
}

function singlePassCounts(): number {
  const counts = countPullRequestFilterValues(
    items,
    (item) => item.approved,
    (item) => item.repository,
  )
  return values.reduce(
    (checksum, value, index) =>
      checksum +
      (value === undefined ? counts.total : (counts.byValue.get(value) ?? 0)) * (index + 1),
    0,
  )
}

const EXPECTED_CHECKSUM = legacyCounts()

function assertChecksum(checksum: number): void {
  if (checksum !== EXPECTED_CHECKSUM) {
    throw new Error(`invalid filter count checksum: ${checksum}`)
  }
}

describe('pull-request value filter counts', () => {
  bench('rescans all pull requests for every value', () => assertChecksum(legacyCounts()), OPTIONS)

  bench('counts all values in one pass', () => assertChecksum(singlePassCounts()), OPTIONS)
})
