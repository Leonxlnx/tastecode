import { bench, describe } from 'vitest'
import { compareWorkspaceEntries, type WorkspaceFileEntry } from './workspace-files.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const ENTRY_COUNT = 10_000
const entries: WorkspaceFileEntry[] = Array.from({ length: ENTRY_COUNT }, (_, index) => ({
  name: `entry-${ENTRY_COUNT - index}-${index % 17}.ts`,
  path: `entry-${ENTRY_COUNT - index}-${index % 17}.ts`,
  kind: index % 5 === 0 ? 'directory' : 'file',
  size: index,
  modifiedAt: index,
  restricted: false,
}))
let checksum = 0

function sortWithPerComparisonOptions(): void {
  const sorted = [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true })
  })
  checksum ^= sorted[0]!.name.length + sorted.at(-1)!.name.length
}

function sortWithRetainedCollator(): void {
  const sorted = [...entries].sort(compareWorkspaceEntries)
  checksum ^= sorted[0]!.name.length + sorted.at(-1)!.name.length
}

describe('large workspace directory ordering', () => {
  bench('creates collation options for each comparison', sortWithPerComparisonOptions, OPTIONS)
  bench('reuses one numeric collator', sortWithRetainedCollator, OPTIONS)
})
