/** How the desktop shows a provider: its name and the logo it draws for it. */
export type ProviderLook = { label: string; mark: string }

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
} satisfies Record<string, ProviderLook>

/** ACP agents with a logo of their own, as the desktop's `agentPresentation` knows them. */
const AGENTS = {
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
} satisfies Record<string, ProviderLook>

/**
 * The name and logo of what a chat runs on, matching the desktop's
 * `sessionSourcePresentation`. A provider or agent it does not know gets the
 * generic connection logo and its id as the name.
 */
export function providerLook(provider: string, agent?: string): ProviderLook {
  if (provider === 'acp' && agent) return known(AGENTS, agent) ?? { label: agent, mark: 'acp' }
  return known(PROVIDERS, provider) ?? { label: provider, mark: 'custom' }
}

function known<Table extends Record<string, ProviderLook>>(
  table: Table,
  id: string,
): ProviderLook | undefined {
  return Object.hasOwn(table, id) ? table[id as keyof Table] : undefined
}
