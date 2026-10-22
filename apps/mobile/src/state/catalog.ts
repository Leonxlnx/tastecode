import type {
  ApprovalMode,
  Capabilities,
  Model,
  ProviderId,
  ProviderStatus,
} from '@harness/contracts'
import { TasteLink } from '../../modules/tastecode-link'
import type { Connection } from '../link/connection'
import { Store } from '../store'

/** Where a chat runs: a provider's own CLI, one ACP agent, or one API connection. */
export type SourceRef = {
  provider: ProviderId
  agent?: string | undefined
  connectionId?: string | undefined
  accountId?: string | undefined
}

export type Source = SourceRef & {
  key: string
  name: string
  capabilities: Capabilities | undefined
  models: readonly Model[]
  status: 'loading' | 'ready' | 'error'
}

export type CatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  sources: readonly Source[]
}

/** A model, effort and access level chosen for a source; remembered per source. */
export type Choice = { model?: string | undefined; effort?: string | undefined }

export function sourceKey(source: SourceRef): string {
  return [source.provider, source.agent ?? source.connectionId ?? '', source.accountId ?? '']
    .join(':')
    .replace(/:+$/, '')
}

/**
 * The model sources this computer offers, read from the server exactly as the
 * desktop's model picker reads them. Shared code never asks which provider a
 * source is: what a source can do comes from its declared capabilities.
 */
export class Catalog {
  readonly state = new Store<CatalogState>({ status: 'idle', sources: [] })
  #loading: Promise<void> | undefined

  constructor(private readonly connection: Connection) {
    connection.onOpen(() => {
      if (this.state.get().status !== 'ready') void this.load()
    })
    connection.on('models.changed', ({ provider, agent }) => {
      for (const source of this.state.get().sources) {
        if (source.provider === provider && source.agent === agent) void this.#loadModels(source)
      }
    })
  }

  load(): Promise<void> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined
    })
    return this.#loading
  }

  async #load(): Promise<void> {
    this.state.set((current) => ({
      ...current,
      status: current.status === 'ready' ? 'ready' : 'loading',
    }))
    try {
      const { providers } = await this.connection.request('providers.list', {})
      const sources = [
        ...providers
          .filter(isDirectSource)
          .map((provider) =>
            source({ provider: provider.id }, provider.displayName, provider.capabilities),
          ),
        ...(await this.#agentSources(providers)),
        ...(await this.#connectionSources(providers)),
      ]
      const previous = new Map(this.state.get().sources.map((entry) => [entry.key, entry]))
      this.state.set({
        status: 'ready',
        sources: sources.map((entry) => {
          const known = previous.get(entry.key)
          return known && known.status === 'ready'
            ? { ...entry, models: known.models, status: 'ready' }
            : entry
        }),
      })
      await Promise.all(this.state.get().sources.map((entry) => this.#loadModels(entry)))
    } catch {
      this.state.set((current) => ({
        ...current,
        status: current.status === 'ready' ? 'ready' : 'error',
      }))
    }
  }

  async #agentSources(providers: readonly ProviderStatus[]): Promise<Source[]> {
    const acp = providers.find((provider) => provider.id === 'acp')
    if (!acp) return []
    try {
      const { agents } = await this.connection.request('acp.agents', {})
      return agents
        .filter((agent) => agent.installed)
        .map((agent) => source({ provider: 'acp', agent: agent.id }, agent.name, acp.capabilities))
    } catch {
      return []
    }
  }

  async #connectionSources(providers: readonly ProviderStatus[]): Promise<Source[]> {
    const api = providers.find((provider) => provider.id === 'api')
    if (!api) return []
    try {
      const { connections } = await this.connection.request('connections.list', {})
      return connections
        .filter((connection) => connection.enabled && connection.credentialConfigured)
        .map((connection) =>
          source(
            { provider: 'api', connectionId: connection.id },
            connection.displayName,
            api.capabilities,
          ),
        )
    } catch {
      return []
    }
  }

  async #loadModels(entry: Source): Promise<void> {
    try {
      const { models } = entry.connectionId
        ? await this.connection.request('connections.models', { connectionId: entry.connectionId })
        : await this.connection.request('models.list', {
            provider: entry.provider,
            ...(entry.agent ? { agent: entry.agent } : {}),
            ...(entry.accountId ? { accountId: entry.accountId } : {}),
          })
      this.#update(entry.key, { models, status: 'ready' })
    } catch {
      this.#update(entry.key, { status: 'error' })
    }
  }

  /** The source a chat runs on, adding it (for another account, say) when the list lacks it. */
  ensure(ref: SourceRef): Source {
    const key = sourceKey(ref)
    const known = this.state.get().sources.find((entry) => entry.key === key)
    if (known) return known
    const base = this.state
      .get()
      .sources.find((entry) => entry.key === sourceKey({ ...ref, accountId: undefined }))
    const added = source(ref, base?.name ?? ref.provider, base?.capabilities)
    this.state.set((current) => ({ ...current, sources: [...current.sources, added] }))
    void this.#loadModels(added)
    return added
  }

  #update(key: string, patch: Partial<Source>): void {
    this.state.set((current) => ({
      ...current,
      sources: current.sources.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    }))
  }
}

function source(ref: SourceRef, name: string, capabilities: Capabilities | undefined): Source {
  return { ...ref, key: sourceKey(ref), name, capabilities, models: [], status: 'loading' }
}

/** A provider that answers for itself, signed in and installed. */
function isDirectSource(provider: ProviderStatus): boolean {
  if (!provider.installed || provider.auth === 'unauthenticated') return false
  const shape = provider.source
  if (!shape) return provider.id !== 'acp' && provider.id !== 'api'
  return shape.direct && !shape.connection && shape.agent !== 'required'
}

/** Models shown first, and the rest behind "More Models". */
export type ModelGroups = { main: Model[]; more: Model[] }

/** The models worth offering first: the source's curated set, without retiring ones. */
export function visibleModels(models: readonly Model[]): ModelGroups {
  const current = models.filter((model) => !model.deprecated)
  const curated = current.filter((model) => model.recommended || model.isDefault)
  if (curated.length === 0 || curated.length === current.length) return { main: current, more: [] }
  return { main: curated, more: current.filter((model) => !curated.includes(model)) }
}

export function defaultModel(models: readonly Model[]): Model | undefined {
  return (
    models.find((model) => model.isDefault) ??
    models.find((model) => !model.deprecated) ??
    models[0]
  )
}

/** The effort to use: the chosen one when the model still offers it, else the model's default. */
export function effortFor(
  model: Model | undefined,
  chosen: string | undefined,
): string | undefined {
  if (!model || model.reasoningEfforts.length === 0) return undefined
  if (chosen && model.reasoningEfforts.includes(chosen)) return chosen
  return model.defaultReasoningEffort ?? model.reasoningEfforts[0]
}

export const ACCESS_LEVELS: ReadonlyArray<{
  mode: ApprovalMode
  title: string
  detail: string
}> = [
  {
    mode: 'ask',
    title: 'Ask first',
    detail: 'Approve each edit and command',
  },
  {
    mode: 'auto',
    title: 'Auto-approve',
    detail: 'Edits and commands in this folder',
  },
  {
    mode: 'auto-review',
    title: 'Auto-review',
    detail: 'A reviewer checks elevated actions',
  },
  { mode: 'full', title: 'Full access', detail: 'No sandbox or prompts' },
]

export function accessLevels(capabilities: Capabilities | undefined): typeof ACCESS_LEVELS {
  return ACCESS_LEVELS.filter((level) => level.mode !== 'auto-review' || capabilities?.autoReview)
}

/** Small JSON preferences kept on the phone (UserDefaults). */
export const preferences = {
  read<T>(key: string): T | undefined {
    const value = TasteLink.readPreference(key)
    if (value === null) return undefined
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  },
  write(key: string, value: unknown): void {
    TasteLink.writePreference(key, value === undefined ? null : JSON.stringify(value))
  },
}

const EFFORT_LABELS = new Map([
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
])

export function effortLabel(effort: string): string {
  return EFFORT_LABELS.get(effort) ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}
