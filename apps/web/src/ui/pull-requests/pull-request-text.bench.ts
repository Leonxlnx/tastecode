import { bench, describe } from 'vitest'
import { comparePullRequestText } from './pull-request-text.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const labels = Array.from(
  { length: 1_000 },
  (_, index) =>
    `${index % 7 === 0 ? 'Á' : 'A'}${index % 11 === 0 ? 'LPHA' : 'lpha'} ${
      1_000 - index
    } ${index % 13 === 0 ? 'ß' : 'z'}`,
)
const options = labels.map((label, index) => ({ label, selected: index % 9 === 0 }))

function legacyComparePullRequestText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

function sortMetadata(compareText: (left: string, right: string) => number): number {
  const filters = [...new Set(labels)].sort(compareText)
  const metadata = options.slice().sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1
    return compareText(left.label, right.label)
  })
  return filters.length + metadata.length
}

function assertResult(result: number): void {
  if (result !== 2_000) throw new Error(`invalid sorted metadata count: ${result}`)
}

describe('pull-request renderer metadata sorting', () => {
  bench(
    'creates locale options for every comparison',
    () => assertResult(sortMetadata(legacyComparePullRequestText)),
    OPTIONS,
  )

  bench(
    'reuses one collator across comparisons',
    () => assertResult(sortMetadata(comparePullRequestText)),
    OPTIONS,
  )
})
