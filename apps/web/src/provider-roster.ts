import type { ProviderId } from '@harness/contracts'

/**
 * The providers the user added, in the order they were added. A direct
 * provider is listed by its id ('codex'), an ACP agent by its source key
 * ('acp:devin'). Nothing else in the app shows, checks or starts a provider
 * that is not on it; API connections and custom harnesses are added in their
 * own places and are not part of it.
 */
export type ProviderRoster = readonly string[]

const ROSTER_KEY = 'harness.providerRoster.v1'

/** The providers with their own integration, in the app's provider order, with who makes each. */
export const DIRECT_PROVIDERS = [
  { id: 'claude-code', maker: 'Anthropic' },
  { id: 'codex', maker: 'OpenAI' },
  { id: 'grok', maker: 'xAI' },
  { id: 'cursor', maker: 'Anysphere' },
  { id: 'opencode', maker: 'SST' },
  { id: 'antigravity', maker: 'Google' },
  { id: 'pi', maker: 'Mario Zechner' },
] as const satisfies ReadonlyArray<{ id: ProviderId; maker: string }>

type DirectProviderId = (typeof DIRECT_PROVIDERS)[number]['id']

const DIRECT_IDS: readonly string[] = DIRECT_PROVIDERS.map((entry) => entry.id)

function isDirectProvider(id: string): id is DirectProviderId {
  return DIRECT_IDS.includes(id)
}

export function agentRosterKey(agentId: string): string {
  return `acp:${agentId}`
}

/** The ACP agent a roster entry names, if it names one. */
export function rosterAgent(key: string): string | undefined {
  return key.startsWith('acp:') ? key.slice(4) : undefined
}

/**
 * Whether a model source may be shown and listed. Before the roster is first
 * saved every direct provider may, as it always could, and no ACP agent;
 * sources the roster does not govern always may.
 */
export function rosterAllows(roster: ProviderRoster | undefined, source: string): boolean {
  if (isDirectProvider(source)) return roster === undefined || roster.includes(source)
  if (rosterAgent(source) !== undefined) return roster?.includes(source) ?? false
  return true
}

/** Undefined until the roster is first saved, so it can start from what is already in use. */
export function readProviderRoster(): ProviderRoster | undefined {
  try {
    const raw = localStorage.getItem(ROSTER_KEY)
    if (raw === null) return undefined
    const stored: unknown = JSON.parse(raw)
    if (!Array.isArray(stored)) return []
    return [...new Set(stored.filter((key): key is string => typeof key === 'string'))]
  } catch {
    return []
  }
}

export function writeProviderRoster(roster: ProviderRoster): void {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(roster))
  } catch {
    // The roster still changes for this run when storage is full or blocked.
  }
}

/**
 * The first roster of someone who used the app before there was one: every
 * installed direct provider, which is what they saw, and every provider or
 * ACP agent that already has a chat, so those chats keep their models.
 */
export function seedProviderRoster(input: {
  providers: readonly { id: ProviderId; installed: boolean }[]
  projects: readonly { sessions: readonly { provider: ProviderId; agent?: string | undefined }[] }[]
}): string[] {
  const installed = DIRECT_PROVIDERS.filter((entry) =>
    input.providers.some((status) => status.id === entry.id && status.installed),
  ).map((entry): string => entry.id)
  const used = input.projects.flatMap((project) =>
    project.sessions.flatMap((session) =>
      session.provider === 'acp' && session.agent
        ? [agentRosterKey(session.agent)]
        : isDirectProvider(session.provider) && !session.agent
          ? [session.provider]
          : [],
    ),
  )
  return [...new Set([...installed, ...used])]
}
