import { describe, expect, it } from 'vitest'
import { choicesFor } from './model-catalog.js'
import { parseModelCatalogCache, serializeModelCatalogCache } from './model-catalog-cache.js'

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
    expect(parseModelCatalogCache(serializeModelCatalogCache(catalog))).toEqual(catalog)
  })

  it('rejects corrupt, unknown-version, and inconsistent snapshots', () => {
    expect(parseModelCatalogCache('{')).toBeUndefined()
    expect(parseModelCatalogCache(JSON.stringify({ version: 2, models: catalog }))).toBeUndefined()
    expect(
      parseModelCatalogCache(
        serializeModelCatalogCache([{ ...catalog[0]!, key: 'codex:another-model' }]),
      ),
    ).toBeUndefined()
  })
})
