import { bench, describe } from 'vitest'
import type { ModelChoice } from '../model-catalog.js'
import { groupModelsBySource, modelSourceKey, type ModelGroup } from './model-selector-utils.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const models = Array.from(
  { length: 10_000 },
  (_, index) =>
    ({
      key: `codex:connection-${index % 500}:model-${index}`,
      provider: 'codex',
      connectionId: `connection-${index % 500}`,
      sourceName: `Connection ${index % 500}`,
      mark: 'openai',
      model: {
        id: `model-${index}`,
        displayName: `Model ${index}`,
        description: '',
        isDefault: index === 0,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    }) satisfies ModelChoice,
)

function legacyGroupModelsBySource(entries: ModelChoice[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  for (const entry of entries) {
    const key = modelSourceKey(entry)
    const group = groups.find((candidate) => candidate.key === key)
    if (group) group.entries.push(entry)
    else groups.push({ key, name: entry.sourceName, mark: entry.mark, entries: [entry] })
  }
  return groups
}

function assertGroups(groups: ModelGroup[]): void {
  if (groups.length !== 500 || groups[499]?.entries.length !== 20) {
    throw new Error('invalid model groups')
  }
}

describe('large model catalog grouping', () => {
  bench(
    'searches existing groups for each model',
    () => assertGroups(legacyGroupModelsBySource(models)),
    OPTIONS,
  )

  bench('indexes groups by source key', () => assertGroups(groupModelsBySource(models)), OPTIONS)
})
