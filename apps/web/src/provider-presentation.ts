import type { ModelConnectionPreset, ProviderId } from '@harness/contracts'

/** ACP agents drawn with the mark the ACP registry publishes for them (ui/agent-marks.ts). */
export const AGENT_MARK_IDS = [
  'devin',
  'copilot',
  'droid',
  'cline',
  'goose',
  'junie',
  'auggie',
  'vibe',
  'kilo',
  'qoder',
  'codebuddy',
] as const
export type AgentMark = (typeof AGENT_MARK_IDS)[number]

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
  | AgentMark

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
  pi: { label: 'Pi', mark: 'pi' },
  acp: { label: 'ACP', mark: 'acp' },
  api: { label: 'API connection', mark: 'custom' },
} as const satisfies Record<ProviderId, ProviderPresentation>

const ACP_AGENTS = {
  gemini: { label: 'Gemini CLI', mark: 'gemini' },
  kimi: { label: 'Kimi CLI', mark: 'kimi' },
  qwen: { label: 'Qwen Code', mark: 'qwen' },
  devin: { label: 'Devin', mark: 'devin' },
  copilot: { label: 'GitHub Copilot', mark: 'copilot' },
  droid: { label: 'Droid', mark: 'droid' },
  cline: { label: 'Cline', mark: 'cline' },
  goose: { label: 'goose', mark: 'goose' },
  junie: { label: 'Junie', mark: 'junie' },
  auggie: { label: 'Auggie', mark: 'auggie' },
  vibe: { label: 'Mistral Vibe', mark: 'vibe' },
  kilo: { label: 'Kilo', mark: 'kilo' },
  qoder: { label: 'Qoder', mark: 'qoder' },
  codebuddy: { label: 'CodeBuddy', mark: 'codebuddy' },
} satisfies Record<string, ProviderPresentation>

/**
 * The one order every provider list follows: Claude Code, then Codex and
 * Grok, then the other CLIs, then ACP agents and API connections. The server
 * reports `providers.list` in the same order.
 */
export const PROVIDER_ORDER: readonly ProviderId[] = [
  'claude-code',
  'codex',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'pi',
  'acp',
  'api',
]

/** A provider's place in `PROVIDER_ORDER`; one it does not name sorts last. */
export function providerRank(provider: ProviderId): number {
  const rank = PROVIDER_ORDER.indexOf(provider)
  return rank === -1 ? PROVIDER_ORDER.length : rank
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
  const sourceCanOverride = input.provider === 'acp' || input.provider === 'api'
  return {
    label: (sourceCanOverride ? input.sourceName?.trim() : undefined) || fallback.label,
    mark: sourceCanOverride ? (input.mark ?? fallback.mark) : fallback.mark,
  }
}

export function connectionMark(preset: ModelConnectionPreset): ProviderMark {
  if (preset === 'openai') return 'openai'
  if (preset === 'anthropic') return 'anthropic'
  return preset
}

export function agentMark(agentId: string): ProviderMark {
  if (agentId === 'gemini' || agentId === 'kimi' || agentId === 'qwen') return agentId
  if ((AGENT_MARK_IDS as readonly string[]).includes(agentId)) return agentId as AgentMark
  return 'acp'
}

export function agentPresentation(
  agentId: string,
  sourceName?: string | undefined,
): ProviderPresentation {
  const known: ProviderPresentation | undefined = ACP_AGENTS[agentId as keyof typeof ACP_AGENTS]
  return sourcePresentation({
    provider: 'acp',
    sourceName: sourceName?.trim() || known?.label || agentId,
    mark: known?.mark ?? agentMark(agentId),
  })
}

export function sessionSourcePresentation(
  provider: ProviderId,
  agentId?: string | undefined,
): ProviderPresentation {
  return provider === 'acp' && agentId ? agentPresentation(agentId) : providerPresentation(provider)
}
