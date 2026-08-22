import { describe, expect, it } from 'vitest'
import { choicesFor } from './model-catalog.js'
import {
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
      provider: 'acp',
      sourceName: 'Kimi CLI',
      mark: 'kimi',
      agent: { id: 'kimi', name: 'Kimi CLI' },
    },
    [{ ...model, id: 'kimi/model' }],
  ),
  ...choicesFor(
    {
      provider: 'api',
      connectionId: 'work-openrouter',
      sourceName: 'Work OpenRouter',
      mark: 'openrouter',
    },
    [{ ...model, id: 'openai/gpt-5.6-sol' }],
  ),
  ...choicesFor(
    {
      provider: 'pi',
      sourceName: 'DeepSeek Pi',
      mark: 'pi',
      agent: { id: 'deepseek-pi', name: 'DeepSeek Pi' },
    },
    [{ ...model, id: 'openrouter/deepseek-v3.2' }],
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
        ['acp:kimi', 1_000],
        ['api:work-openrouter', 1_000],
        ['pi:deepseek-pi', 1_000],
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
    expect(isModelCatalogSourceFresh(cache, 'acp:kimi', 1_000)).toBe(false)
    expect(
      isModelCatalogSourceFresh(
        parseModelCatalogCache(JSON.stringify({ version: 1, models: catalog })),
        'codex',
        1_000,
      ),
    ).toBe(false)
  })

  it('rejects corrupt, unknown-version, and inconsistent snapshots', () => {
    expect(parseModelCatalogCache('{')).toBeUndefined()
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
