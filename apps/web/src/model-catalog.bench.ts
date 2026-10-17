import { bench, describe } from 'vitest'
import {
  choicesFor,
  effectiveHiddenModels,
  modelVisibilityDefaults,
  readModelLineage,
  type ModelChoice,
} from './model-catalog.js'

const OPTIONS = { iterations: 50, time: 0, warmupIterations: 10, warmupTime: 0 }
const LABS = ['DeepSeek', 'MiniMax', 'Qwen', 'GLM', 'Kimi', 'Gemini', 'Claude', 'GPT', 'Grok']
const TIERS = ['Flash', 'Pro', 'Mini', 'Coder', 'Max']

// A models.dev-sized catalog: one huge source with versioned names, plus a few
// small direct sources, 10,000 rows in all.
const catalog: ModelChoice[] = [
  ...choicesFor(
    { provider: 'opencode', sourceName: 'OpenCode', mark: 'opencode' },
    Array.from({ length: 9_970 }, (_, index) => ({
      id: `provider-${index % 230}/model-${index}`,
      displayName: `${LABS[index % LABS.length]} ${1 + (index % 7)}.${index % 10} ${
        TIERS[index % TIERS.length]
      } ${Math.floor(index / 315)}`,
      isDefault: index === 0,
      reasoningEfforts: [],
      serviceTiers: [],
    })),
  ),
  ...(['codex', 'claude-code', 'grok'] as const).flatMap((provider) =>
    choicesFor(
      { provider, sourceName: provider, mark: 'custom' },
      Array.from({ length: 10 }, (_, index) => ({
        id: `${provider}-${index}`,
        displayName: `Model ${index % 5}.${index} Tier`,
        isDefault: index === 0,
        reasoningEfforts: [],
        serviceTiers: [],
      })),
    ),
  ),
]
const defaults = modelVisibilityDefaults(catalog)
const overrides = Object.fromEntries(
  catalog.slice(0, 500).map((choice, index) => [choice.key, { visible: index % 2 === 0, at: 1 }]),
)
const firstSeen = Object.fromEntries(catalog.map((choice) => [choice.key, 2]))

describe(`generic model visibility over ${catalog.length} rows`, () => {
  // The first catalog of a launch reads every name once.
  bench(
    'reads every name',
    () => catalog.forEach(({ model }) => readModelLineage(model.displayName)),
    OPTIONS,
  )
  // Later refreshes keep the model objects of the sources they did not relist.
  bench('computes the defaults again', () => void modelVisibilityDefaults(catalog), OPTIONS)
  bench(
    'applies overrides',
    () => void effectiveHiddenModels(catalog, defaults, overrides, firstSeen),
    OPTIONS,
  )
})
