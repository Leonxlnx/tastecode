import { describe, expect, it } from 'vitest'
import { choicesFor } from './model-catalog.js'
import {
  freshModelCatalogChoices,
  isModelCatalogSourceFresh,
  MODEL_CATALOG_CACHE_FRESH_MS,
  parseModelCatalogCache,
  serializeModelCatalogCache,
} from './model-catalog-cache.js'

const model = {
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  isDefault: true,
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'high',
  serviceTiers: [],
}
const catalog = [
  ...choicesFor({ provider: 'codex', sourceName: 'Codex', mark: 'openai' }, [model]),
  ...choicesFor(
    {
      provider: 'grok',
      sourceName: 'Work Grok',
      mark: 'grok',
      agent: { id: 'work-grok', name: 'Work Grok' },
    },
    [{ ...model, id: 'grok-4.6' }],
  ),
  ...choicesFor(
    {
      provider: 'claude-code',
      sourceName: 'Claude Fork',
      mark: 'anthropic',
      agent: { id: 'claude-fork', name: 'Claude Fork' },
    },
    [{ ...model, id: 'opus' }],
  ),
]

describe('model catalog cache', () => {
  it('round-trips a validated renderer snapshot', () => {
    expect(
      parseModelCatalogCache(serializeModelCatalogCache(catalog, { validatedAt: 1_000 })),
    ).toEqual({
      models: catalog,
      validatedSources: new Map([
        ['codex', 1_000],
        ['grok:work-grok', 1_000],
        ['claude-code:claude-fork', 1_000],
      ]),
    })
  })

  it('reuses only the recent sources that were validated', () => {
    const cache = parseModelCatalogCache(
      serializeModelCatalogCache(catalog, {
        validatedSources: ['codex'],
        validatedAt: 1_000,
      }),
    )
    expect(isModelCatalogSourceFresh(cache, 'codex', 1_000 + MODEL_CATALOG_CACHE_FRESH_MS)).toBe(
      true,
    )
    expect(isModelCatalogSourceFresh(cache, 'codex', 1_001 + MODEL_CATALOG_CACHE_FRESH_MS)).toBe(
      false,
    )
    expect(isModelCatalogSourceFresh(cache, 'grok:work-grok', 1_000)).toBe(false)
    expect(
      isModelCatalogSourceFresh(
        parseModelCatalogCache(JSON.stringify({ version: 1, models: catalog })),
        'codex',
        1_000,
      ),
    ).toBe(false)
    expect(freshModelCatalogChoices(cache, 1_000)).toEqual([catalog[0]])
    expect(freshModelCatalogChoices(cache, 1_001 + MODEL_CATALOG_CACHE_FRESH_MS)).toEqual([])
  })

  it('rejects corrupt, unknown-version, and inconsistent snapshots', () => {
    expect(parseModelCatalogCache('{')).toBeUndefined()
    // A snapshot from a build that still had API connections is stale, not partly valid.
    const withConnection = JSON.parse(serializeModelCatalogCache([catalog[0]!])) as {
      models: Array<Record<string, unknown>>
    }
    withConnection.models[0]!['connectionId'] = 'work-openrouter'
    expect(parseModelCatalogCache(JSON.stringify(withConnection))).toBeUndefined()
    expect(parseModelCatalogCache(JSON.stringify({ version: 3, models: catalog }))).toBeUndefined()
    expect(parseModelCatalogCache(JSON.stringify({ version: 2, models: catalog }))).toBeUndefined()
    expect(
      parseModelCatalogCache(
        serializeModelCatalogCache([{ ...catalog[0]!, key: 'codex:another-model' }]),
      ),
    ).toBeUndefined()
  })

  it('keeps schema defaults and rejects invalid nested model data', () => {
    const cached = JSON.parse(serializeModelCatalogCache([catalog[0]!])) as {
      models: Array<{ model: Record<string, unknown> }>
    }
    delete cached.models[0]!.model['serviceTiers']
    expect(parseModelCatalogCache(JSON.stringify(cached))?.models[0]?.model.serviceTiers).toEqual(
      [],
    )

    cached.models[0]!.model['reasoningEfforts'] = ['high', 1]
    expect(parseModelCatalogCache(JSON.stringify(cached))).toBeUndefined()
  })
})
