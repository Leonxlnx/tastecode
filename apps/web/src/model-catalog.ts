import type { Model, ModelConnectionPreset, ProviderId } from '@harness/contracts'

export type ProviderMark =
  | 'openai'
  | 'anthropic'
  | 'cursor'
  | 'opencode'
  | 'openrouter'
  | 'kimi'
  | 'gemini'
  | 'qwen'
  | 'zai'
  | 'acp'
  | 'custom'

export type ModelChoice = {
  key: string
  provider: ProviderId
  sourceName: string
  mark: ProviderMark
  connectionId?: string | undefined
  agent?: { id: string; name: string } | undefined
  model: Model
}

export function sourceKey(input: {
  provider: ProviderId
  connectionId?: string | undefined
  agentId?: string | undefined
}): string {
  if (input.connectionId) return `api:${input.connectionId}`
  if (input.agentId) return `acp:${input.agentId}`
  return input.provider
}

export function modelChoiceKey(source: string, modelId: string): string {
  return `${source}:${encodeURIComponent(modelId || 'automatic')}`
}

export function automaticModel(): Model {
  return {
    id: '',
    displayName: 'Automatic',
    description: 'Let the provider choose its default model',
    isDefault: true,
    reasoningEfforts: [],
    serviceTiers: [],
  }
}

export function providerMark(provider: ProviderId): ProviderMark {
  if (provider === 'codex') return 'openai'
  if (provider === 'claude-code') return 'anthropic'
  if (provider === 'api') return 'custom'
  return provider
}

export function connectionMark(preset: ModelConnectionPreset): ProviderMark {
  if (preset === 'openai') return 'openai'
  if (preset === 'anthropic') return 'anthropic'
  return preset
}

export function agentMark(agentId: string): ProviderMark {
  if (agentId === 'gemini' || agentId === 'kimi' || agentId === 'qwen') return agentId
  return 'acp'
}

export function choicesFor(
  input: Omit<ModelChoice, 'key' | 'model'>,
  models: Model[],
): ModelChoice[] {
  const source = sourceKey({
    provider: input.provider,
    connectionId: input.connectionId,
    agentId: input.agent?.id,
  })
  return (models.length > 0 ? models : [automaticModel()]).map((model) => ({
    ...input,
    model,
    key: modelChoiceKey(source, model.id),
  }))
}
