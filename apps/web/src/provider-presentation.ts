import type { ModelConnectionPreset, ProviderId } from '@harness/contracts'

export type ProviderMark =
  | 'openai'
  | 'anthropic'
  | 'grok'
  | 'cursor'
  | 'opencode'
  | 'openrouter'
  | 'kimi'
  | 'gemini'
  | 'qwen'
  | 'zai'
  | 'antigravity'
  | 'pi'
  | 'acp'
  | 'custom'

export type ProviderPresentation = {
  label: string
  mark: ProviderMark
}

const PROVIDERS = {
  codex: { label: 'Codex', mark: 'openai' },
  'claude-code': { label: 'Claude Code', mark: 'anthropic' },
  grok: { label: 'Grok', mark: 'grok' },
  cursor: { label: 'Cursor', mark: 'cursor' },
  opencode: { label: 'OpenCode', mark: 'opencode' },
  antigravity: { label: 'Antigravity', mark: 'antigravity' },
  acp: { label: 'ACP', mark: 'acp' },
  api: { label: 'API connection', mark: 'custom' },
} as const satisfies Record<ProviderId, ProviderPresentation>

const ACP_AGENTS: Record<string, ProviderPresentation> = {
  gemini: { label: 'Gemini CLI', mark: 'gemini' },
  kimi: { label: 'Kimi CLI', mark: 'kimi' },
  qwen: { label: 'Qwen Code', mark: 'qwen' },
}

export function providerPresentation(provider: ProviderId): ProviderPresentation {
  return PROVIDERS[provider]
}

export function providerDisplayName(provider: ProviderId): string {
  return providerPresentation(provider).label
}

export function providerMark(provider: ProviderId): ProviderMark {
  return providerPresentation(provider).mark
}

export function sourcePresentation(input: {
  provider: ProviderId
  sourceName?: string | undefined
  mark?: ProviderMark | undefined
}): ProviderPresentation {
  const fallback = providerPresentation(input.provider)
  return {
    label: input.sourceName?.trim() || fallback.label,
    mark: input.mark ?? fallback.mark,
  }
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

export function agentPresentation(
  agentId: string,
  sourceName?: string | undefined,
): ProviderPresentation {
  const known = ACP_AGENTS[agentId]
  return sourcePresentation({
    provider: 'acp',
    sourceName: sourceName?.trim() || known?.label || agentId,
    mark: known?.mark ?? agentMark(agentId),
  })
}
