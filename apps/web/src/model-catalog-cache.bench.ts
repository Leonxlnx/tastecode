import { ModelSchema, ProviderIdSchema } from '@harness/contracts'
import { bench, describe } from 'vitest'
import { z } from 'zod'
import { choicesFor } from './model-catalog.js'
import { parseModelCatalogCache, serializeModelCatalogCache } from './model-catalog-cache.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const ProviderMarkSchema = z.enum([
  'openai',
  'anthropic',
  'grok',
  'cursor',
  'opencode',
  'openrouter',
  'kimi',
  'gemini',
  'qwen',
  'zai',
  'antigravity',
  'pi',
  'acp',
  'custom',
])
const SchemaCache = z.object({
  version: z.literal(2),
  validatedSources: z
    .array(
      z.object({
        source: z.string().min(1),
        validatedAt: z.number().int().nonnegative(),
      }),
    )
    .max(2_000),
  models: z
    .array(
      z.object({
        key: z.string().min(1),
        provider: ProviderIdSchema,
        sourceName: z.string().min(1),
        mark: ProviderMarkSchema,
        connectionId: z.string().min(1).optional(),
        agent: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
        model: ModelSchema,
      }),
    )
    .max(2_000),
})
const catalog = choicesFor(
  { provider: 'codex', sourceName: 'Codex', mark: 'openai' },
  Array.from({ length: 2_000 }, (_, index) => ({
    id: `gpt-model-${index}`,
    displayName: `GPT Model ${index}`,
    description: 'A model used to exercise the largest supported launch cache.',
    isDefault: index === 0,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority routing' }],
  })),
)
const raw = serializeModelCatalogCache(catalog)

describe('largest supported model catalog startup cache', () => {
  bench(
    'parses 2,000 models through Zod schemas',
    () => {
      if (SchemaCache.parse(JSON.parse(raw)).models.length !== 2_000) {
        throw new Error('missing cached models')
      }
    },
    OPTIONS,
  )

  bench(
    'validates 2,000 models directly',
    () => {
      if (parseModelCatalogCache(raw)?.models.length !== 2_000) {
        throw new Error('missing cached models')
      }
    },
    OPTIONS,
  )
})
