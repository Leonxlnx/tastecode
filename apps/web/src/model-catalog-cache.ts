import { ModelSchema, ProviderIdSchema } from '@harness/contracts'
import { modelChoiceKey, sourceKey, type ModelChoice, type ProviderMark } from './model-catalog.js'

const CACHE_VERSION = 1
const MAX_CACHE_CHARACTERS = 2_000_000
const MAX_CACHED_MODELS = 2_000
const PROVIDER_MARKS = new Set<ProviderMark>([
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

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== CACHE_VERSION || !Array.isArray(value.models)) {
    return undefined
  }
  if (value.models.length > MAX_CACHED_MODELS) return undefined

  const choices: ModelChoice[] = []
  for (const candidate of value.models) {
    if (!isRecord(candidate)) return undefined
    const provider = ProviderIdSchema.safeParse(candidate.provider)
    const model = ModelSchema.safeParse(candidate.model)
    if (
      !provider.success ||
      !model.success ||
      typeof candidate.key !== 'string' ||
      candidate.key.length === 0 ||
      typeof candidate.sourceName !== 'string' ||
      candidate.sourceName.length === 0 ||
      typeof candidate.mark !== 'string' ||
      !PROVIDER_MARKS.has(candidate.mark as ProviderMark)
    ) {
      return undefined
    }

    const connectionId = optionalNonEmptyString(candidate.connectionId)
    if (connectionId === null) return undefined
    const agent = parseAgent(candidate.agent)
    if (agent === null) return undefined
    const connectionShapeValid =
      provider.data === 'api' ? Boolean(connectionId) && !agent : !connectionId
    const sourceShapeValid =
      provider.data === 'acp' || provider.data === 'pi' ? Boolean(agent) : true
    if (!connectionShapeValid || !sourceShapeValid) {
      return undefined
    }

    const choice: ModelChoice = {
      key: candidate.key,
      provider: provider.data,
      sourceName: candidate.sourceName,
      mark: candidate.mark as ProviderMark,
      ...(connectionId ? { connectionId } : {}),
      ...(agent ? { agent } : {}),
      model: model.data,
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

function parseAgent(value: unknown): ModelChoice['agent'] | null {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0
  ) {
    return null
  }
  return { id: value.id, name: value.name }
}

function optionalNonEmptyString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
