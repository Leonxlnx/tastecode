import { ModelSchema, ProviderIdSchema } from '@harness/contracts'
import { z } from 'zod'
import { modelChoiceKey, sourceKey, type ModelChoice } from './model-catalog.js'

const CACHE_VERSION = 1
const MAX_CACHE_CHARACTERS = 2_000_000
const MAX_CACHED_MODELS = 2_000
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

const CachedModelChoiceSchema = z.object({
  key: z.string().min(1),
  provider: ProviderIdSchema,
  sourceName: z.string().min(1),
  mark: ProviderMarkSchema,
  connectionId: z.string().min(1).optional(),
  agent: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional(),
  model: ModelSchema,
})

const ModelCatalogCacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  models: z.array(CachedModelChoiceSchema).max(MAX_CACHED_MODELS),
})

/**
 * A renderer snapshot, never the source of truth. It makes a previously loaded
 * catalog available on the first frame while the server revalidates the
 * machine in the background.
 */
export function serializeModelCatalogCache(models: ModelChoice[]): string {
  return JSON.stringify({ version: CACHE_VERSION, models })
}

export function parseModelCatalogCache(raw: string | null): ModelChoice[] | undefined {
  if (!raw || raw.length > MAX_CACHE_CHARACTERS) return undefined

  let value: z.input<typeof ModelCatalogCacheSchema>
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  const cache = ModelCatalogCacheSchema.safeParse(value)
  if (!cache.success) return undefined

  const choices: ModelChoice[] = []
  for (const candidate of cache.data.models) {
    const connectionId = candidate.connectionId
    const agent = candidate.agent
    const connectionContractValid =
      candidate.provider === 'api' ? Boolean(connectionId) && !agent : !connectionId
    const sourceContractValid =
      candidate.provider === 'acp' || candidate.provider === 'pi' ? Boolean(agent) : true
    if (!connectionContractValid || !sourceContractValid) {
      return undefined
    }

    const choice: ModelChoice = {
      key: candidate.key,
      provider: candidate.provider,
      sourceName: candidate.sourceName,
      mark: candidate.mark,
      ...(connectionId ? { connectionId } : {}),
      ...(agent ? { agent } : {}),
      model: candidate.model,
    }
    const expectedKey = modelChoiceKey(
      sourceKey({
        provider: choice.provider,
        connectionId: choice.connectionId,
        agentId: choice.agent?.id,
      }),
      choice.model.id,
    )
    if (choice.key !== expectedKey) return undefined
    choices.push(choice)
  }
  return choices
}
