import type { Model, ProviderId } from '@harness/contracts'
import { modelChoiceKey, sourceKey, type ModelChoice } from './model-catalog.js'
import type { ProviderMark } from './provider-presentation.js'

const CACHE_VERSION = 2
const MAX_CACHE_CHARACTERS = 2_000_000
const MAX_CACHED_MODELS = 2_000
export const MODEL_CATALOG_CACHE_FRESH_MS = 5 * 60_000
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

export type ModelCatalogCache = {
  models: ModelChoice[]
  /** Empty on the readable v1 cache, which is always treated as stale. */
  validatedSources: Map<string, number>
}

type SerializeModelCatalogCacheOptions = {
  validatedSources?: Iterable<string> | undefined
  validatedAt?: number | undefined
}

/**
 * A renderer snapshot, never the source of truth. It makes a previously loaded
 * catalog available on the first frame and avoids respawning provider helpers
 * during rapid relaunches. Opening the picker and explicit refreshes still
 * revalidate immediately.
 */
export function serializeModelCatalogCache(
  models: ModelChoice[],
  options: SerializeModelCatalogCacheOptions = {},
): string {
  const validatedAt = options.validatedAt ?? Date.now()
  const validatedSources = [
    ...new Set(
      options.validatedSources ??
        models.map((choice) =>
          sourceKey({
            provider: choice.provider,
            connectionId: choice.connectionId,
            agentId: choice.agent?.id,
          }),
        ),
    ),
  ].map((source) => ({ source, validatedAt }))
  return JSON.stringify({ version: CACHE_VERSION, validatedSources, models })
}

export function parseModelCatalogCache(raw: string | null): ModelCatalogCache | undefined {
  if (!raw || raw.length > MAX_CACHE_CHARACTERS) return undefined

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    (value['version'] !== 1 && value['version'] !== CACHE_VERSION) ||
    !Array.isArray(value['models']) ||
    value['models'].length > MAX_CACHED_MODELS
  ) {
    return undefined
  }

  const choices: ModelChoice[] = []
  for (const rawCandidate of value['models']) {
    const candidate = parseCachedModelChoice(rawCandidate)
    if (!candidate) return undefined
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

  const validatedSources = new Map<string, number>()
  if (value['version'] === CACHE_VERSION) {
    const rawSources = value['validatedSources']
    if (!Array.isArray(rawSources) || rawSources.length > MAX_CACHED_MODELS) return undefined
    const modelSources = new Set(
      choices.map((choice) =>
        sourceKey({
          provider: choice.provider,
          connectionId: choice.connectionId,
          agentId: choice.agent?.id,
        }),
      ),
    )
    for (const rawSource of rawSources) {
      if (!isRecord(rawSource)) return undefined
      const source = rawSource['source']
      const validatedAt = rawSource['validatedAt']
      if (
        !isNonemptyString(source) ||
        !modelSources.has(source) ||
        validatedSources.has(source) ||
        typeof validatedAt !== 'number' ||
        !Number.isSafeInteger(validatedAt) ||
        validatedAt < 0
      ) {
        return undefined
      }
      validatedSources.set(source, validatedAt)
    }
  }
  return { models: choices, validatedSources }
}

export function isModelCatalogSourceFresh(
  cache: ModelCatalogCache | undefined,
  source: string,
  now = Date.now(),
): boolean {
  const validatedAt = cache?.validatedSources.get(source)
  if (validatedAt === undefined || !Number.isFinite(now)) return false
  const age = now - validatedAt
  return age >= 0 && age <= MODEL_CATALOG_CACHE_FRESH_MS
}

export function freshModelCatalogChoices(
  cache: ModelCatalogCache | undefined,
  now = Date.now(),
): ModelChoice[] {
  return (
    cache?.models.filter((choice) =>
      isModelCatalogSourceFresh(
        cache,
        sourceKey({
          provider: choice.provider,
          connectionId: choice.connectionId,
          agentId: choice.agent?.id,
        }),
        now,
      ),
    ) ?? []
  )
}

function parseCachedModelChoice(value: unknown): ModelChoice | undefined {
  if (!isRecord(value)) return undefined
  const key = value['key']
  const provider = parseProviderId(value['provider'])
  const sourceName = value['sourceName']
  const mark = value['mark']
  const connectionId = value['connectionId']
  const rawAgent = value['agent']
  const model = parseModel(value['model'])
  if (
    !isNonemptyString(key) ||
    !provider ||
    !isNonemptyString(sourceName) ||
    !isProviderMark(mark) ||
    (connectionId !== undefined && !isNonemptyString(connectionId)) ||
    !model
  ) {
    return undefined
  }

  let agent: { id: string; name: string } | undefined
  if (rawAgent !== undefined) {
    if (
      !isRecord(rawAgent) ||
      !isNonemptyString(rawAgent['id']) ||
      !isNonemptyString(rawAgent['name'])
    ) {
      return undefined
    }
    agent = { id: rawAgent['id'], name: rawAgent['name'] }
  }

  return {
    key,
    provider,
    sourceName,
    mark,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(agent ? { agent } : {}),
    model,
  }
}

function parseModel(value: unknown): Model | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const displayName = value['displayName']
  const description = value['description']
  const isDefault = value['isDefault']
  const reasoningEfforts = value['reasoningEfforts']
  const defaultReasoningEffort = value['defaultReasoningEffort']
  const rawServiceTiers = value['serviceTiers']
  const defaultServiceTier = value['defaultServiceTier']
  if (
    typeof id !== 'string' ||
    typeof displayName !== 'string' ||
    (description !== undefined && typeof description !== 'string') ||
    typeof isDefault !== 'boolean' ||
    !isStringArray(reasoningEfforts) ||
    (defaultReasoningEffort !== undefined && typeof defaultReasoningEffort !== 'string') ||
    (rawServiceTiers !== undefined && !Array.isArray(rawServiceTiers)) ||
    (defaultServiceTier !== undefined &&
      defaultServiceTier !== null &&
      typeof defaultServiceTier !== 'string')
  ) {
    return undefined
  }

  const serviceTiers: Model['serviceTiers'] = []
  for (const rawTier of rawServiceTiers ?? []) {
    if (
      !isRecord(rawTier) ||
      typeof rawTier['id'] !== 'string' ||
      typeof rawTier['name'] !== 'string' ||
      typeof rawTier['description'] !== 'string'
    ) {
      return undefined
    }
    serviceTiers.push({
      id: rawTier['id'],
      name: rawTier['name'],
      description: rawTier['description'],
    })
  }

  return {
    id,
    displayName,
    ...(description === undefined ? {} : { description }),
    isDefault,
    reasoningEfforts,
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    serviceTiers,
    ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
  }
}

function parseProviderId(value: unknown): ProviderId | undefined {
  if (
    value === 'codex' ||
    value === 'claude-code' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'opencode' ||
    value === 'antigravity' ||
    value === 'pi' ||
    value === 'acp' ||
    value === 'api'
  ) {
    return value
  }
  return undefined
}

function isProviderMark(value: unknown): value is ProviderMark {
  return typeof value === 'string' && PROVIDER_MARKS.has(value as ProviderMark)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
