import { describe, expect, it } from 'vitest'
import { choicesFor } from './model-catalog.js'
import {
  freshModelCatalogChoices,
  isModelCatalogSourceFresh,
  MAX_CACHE_CHARACTERS,
  MAX_CACHED_MODELS,
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
    expect(freshModelCatalogChoices(cache, 1_000)).toEqual([catalog[0]])
    expect(freshModelCatalogChoices(cache, 1_001 + MODEL_CATALOG_CACHE_FRESH_MS)).toEqual([])
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

  it('never serializes a snapshot the reader would reject', () => {
    const codexRows = (count: number, description = '') =>
      choicesFor(
        { provider: 'codex', sourceName: 'Codex', mark: 'openai' },
        Array.from({ length: count }, (_, index) => ({
          ...model,
          id: `gpt-model-${index}`,
          description,
          isDefault: index === 0,
        })),
      )

    const largest = serializeModelCatalogCache(codexRows(MAX_CACHED_MODELS))
    expect(parseModelCatalogCache(largest)?.models).toHaveLength(MAX_CACHED_MODELS)
    expect(serializeModelCatalogCache(codexRows(MAX_CACHED_MODELS + 1))).toBeUndefined()
    // Few rows, but each one carries a long description.
    const wordy = codexRows(3, 'x'.repeat(Math.ceil(MAX_CACHE_CHARACTERS / 3)))
    expect(serializeModelCatalogCache(wordy)).toBeUndefined()
    expect(serializeModelCatalogCache(catalog, { validatedAt: Number.NaN })).toBeUndefined()
  })

  it('leaves out a validated source that has no rows', () => {
    // A connection that listed nothing used to make the whole snapshot unreadable.
    const cache = parseModelCatalogCache(
      serializeModelCatalogCache([catalog[0]!], {
        validatedSources: ['codex', 'api:empty-connection'],
        validatedAt: 1_000,
      }),
    )
    expect(cache?.validatedSources).toEqual(new Map([['codex', 1_000]]))
  })

  it('keeps schema defaults and rejects invalid nested model data', () => {
    const cached = JSON.parse(serializeModelCatalogCache([catalog[0]!])!) as {
      models: Array<{ model: Record<string, unknown> }>
    }
    delete cached.models[0]!.model['serviceTiers']
    expect(parseModelCatalogCache(JSON.stringify(cached))?.models[0]?.model.serviceTiers).toEqual(
      [],
    )

    cached.models[0]!.model['reasoningEfforts'] = ['high', 1]
    expect(parseModelCatalogCache(JSON.stringify(cached))).toBeUndefined()
  })

  it('keeps the lineage and curation an adapter declared', () => {
    const declared = choicesFor(
      { provider: 'opencode', sourceName: 'OpenCode', mark: 'opencode' },
      [
        {
          ...model,
          id: 'deepseek/deepseek-v4.1-flash',
          lab: 'DeepSeek',
          family: 'deepseek-flash',
          generation: '4.1',
          released: '2026-09-30',
          recommended: true,
          deprecated: false,
        },
        { ...model, id: 'minimax/MiniMax-M2.5', isDefault: false, deprecated: true },
      ],
    )
    expect(parseModelCatalogCache(serializeModelCatalogCache(declared))?.models).toEqual(declared)
    // A snapshot written before the fields existed reads as before.
    expect(parseModelCatalogCache(serializeModelCatalogCache([catalog[0]!]))?.models).toEqual([
      catalog[0],
    ])
  })

  it('drops only the declared fields the protocol would not accept', () => {
    const cached = JSON.parse(serializeModelCatalogCache([catalog[0]!])!) as {
      models: Array<{ model: Record<string, unknown> }>
    }
    Object.assign(cached.models[0]!.model, {
      lab: '',
      family: 'x'.repeat(121),
      generation: 6,
      released: '2026-9-30',
      recommended: 'yes',
      deprecated: 1,
    })
    expect(parseModelCatalogCache(JSON.stringify(cached))?.models).toEqual([catalog[0]])
    Object.assign(cached.models[0]!.model, { family: 'gpt-sol', generation: '5.6' })
    expect(parseModelCatalogCache(JSON.stringify(cached))?.models[0]?.model).toEqual({
      ...model,
      family: 'gpt-sol',
      generation: '5.6',
    })
  })
})
