import type { McpCapabilities, McpServer, ProviderCommand, ResultOf } from '@harness/contracts'

/** What a provider loads for one project when no chat is open there. */
export type ProjectInventory = { commands: ProviderCommand[]; servers: McpServer[] }
export type ProjectInventoryPart = 'commands' | 'mcp'

/**
 * Reads a project's inventory by starting the provider without a chat. It
 * may report an early answer while MCP servers still start; the resolved
 * value is final. It must stop its processes when the signal aborts.
 */
export type ProjectInventoryProbe = (
  projectPath: string,
  options: { signal: AbortSignal; onUpdate: (inventory: ProjectInventory) => void },
) => Promise<ProjectInventory>

/** A provider that can read a project's commands and MCP servers without a chat. */
export type ProjectInventoryService = {
  /** What the MCP inventory supports when the probe answers. */
  mcpCapabilities: McpCapabilities
  discover: ProjectInventoryProbe
}

/** The provider's own servers, before TasteCode's project overrides. */
type McpList = { capabilities: McpCapabilities; servers: McpServer[]; loading?: boolean }
type CommandList = ResultOf<'commands.list'>
type Held<T> = { value: T; at: number; live: boolean }
type PartValue = { mcp: McpServer[]; commands: ProviderCommand[] }
/** A cached part, and whether a probe that will report it is still running. */
type Lookup<T> = { value: T | undefined; loading: boolean }
type Entry = {
  commands?: Held<ProviderCommand[]> | undefined
  servers?: Held<McpServer[]> | undefined
  /** The servers came from a probe's early answer, and that probe still runs. */
  partial: boolean
  state: 'idle' | 'queued' | 'probing'
  abort?: AbortController | undefined
  probeStartedAt: number
  /** Invalidated during the probe, so its answer may predate the change. */
  dirty: boolean
  /** Parts a reader was told are loading; they hear when the probe ends. */
  awaited: Set<ProjectInventoryPart>
  failedAt?: number | undefined
}

export type ProjectInventoryCacheOptions = {
  service: ProjectInventoryService
  onChanged: (projectPath: string, parts: ProjectInventoryPart[]) => void
  onError?: (projectPath: string, error: unknown) => void
  /** How long an answer counts as current; an older one answers while a refresh runs. */
  ttlMs?: number
  /** The longest one probe may run before it is stopped. */
  timeoutMs?: number
  /** How long a project whose probe failed answers "unavailable" before the next try. */
  retryMs?: number
  maxProjects?: number
}

/**
 * One provider's project inventories. A probe starts a whole agent (Claude:
 * 10-15 s, plus every MCP server), so answers are cached per project, probes
 * run one at a time, a live chat's answer is preferred and kept, and an
 * expired answer still answers at once while a refresh runs behind it.
 */
export class ProjectInventoryCache {
  readonly #options: ProjectInventoryCacheOptions
  readonly #entries = new Map<string, Entry>()
  readonly #queue: string[] = []
  readonly #ttlMs: number
  readonly #timeoutMs: number
  readonly #retryMs: number
  readonly #maxProjects: number
  #running: { projectPath: string; timer: ReturnType<typeof setTimeout> } | undefined

  constructor(options: ProjectInventoryCacheOptions) {
    this.#options = options
    this.#ttlMs = options.ttlMs ?? 10 * 60_000
    this.#timeoutMs = options.timeoutMs ?? 45_000
    this.#retryMs = options.retryMs ?? 60_000
    this.#maxProjects = options.maxProjects ?? 32
  }

  /** A live chat answers first; without one, the cache or a probe does. */
  async listMcpServers(
    projectPath: string,
    readActive?: () => Promise<Omit<McpList, 'capabilities'>>,
  ): Promise<McpList> {
    const capabilities = this.#options.service.mcpCapabilities
    if (readActive) {
      try {
        const live = await readActive()
        // Servers still starting would be stored without the change that follows.
        if (!live.loading) this.#storeLive(projectPath, 'mcp', live.servers)
        return { capabilities, ...live }
      } catch {
        // The chat closed during the read; answer as if it had not been open.
      }
    }
    const { value, loading } = this.#read(projectPath, 'mcp')
    if (value) return { capabilities, servers: value, ...(loading ? { loading: true } : {}) }
    if (loading) return { capabilities, servers: [], loading: true }
    return { capabilities: { ...capabilities, inventory: false }, servers: [] }
  }

  async listCommands(
    projectPath: string,
    readActive?: () => Promise<ProviderCommand[]>,
  ): Promise<CommandList> {
    if (readActive) {
      try {
        const commands = await readActive()
        this.#storeLive(projectPath, 'commands', commands)
        return { commands, loading: false }
      } catch {
        // The chat closed during the read.
      }
    }
    const { value, loading } = this.#read(projectPath, 'commands')
    return { commands: value ?? [], loading }
  }

  /** A live answer about servers TasteCode added is wrong once that list changes. */
  forgetLiveServers(projectPath: string): void {
    const entry = this.#entries.get(projectPath)
    if (entry?.servers?.live) entry.servers = undefined
  }

  forget(projectPath: string): void {
    const entry = this.#entries.get(projectPath)
    if (!entry) return
    entry.abort?.abort()
    this.#entries.delete(projectPath)
    this.#unqueue(projectPath)
  }

  clear(): void {
    if (this.#running) clearTimeout(this.#running.timer)
    this.#running = undefined
    for (const entry of this.#entries.values()) entry.abort?.abort()
    this.#entries.clear()
    this.#queue.length = 0
  }

  #read<P extends ProjectInventoryPart>(projectPath: string, part: P): Lookup<PartValue[P]> {
    const entry = this.#entry(projectPath)
    const held = part === 'mcp' ? entry.servers : entry.commands
    const now = Date.now()
    const current = held !== undefined && now - held.at < this.#ttlMs
    const retry = held !== undefined || entry.failedAt === undefined
    if (!current && entry.state === 'idle' && (retry || now - entry.failedAt! >= this.#retryMs)) {
      this.#enqueue(projectPath, entry)
    }
    const loading =
      entry.state !== 'idle' && (held === undefined || (part === 'mcp' && entry.partial))
    if (loading) entry.awaited.add(part)
    return { value: held?.value as PartValue[P] | undefined, loading }
  }

  #storeLive(projectPath: string, part: ProjectInventoryPart, value: unknown[]): void {
    const entry = this.#entry(projectPath)
    const held = { value, at: Date.now(), live: true }
    if (part === 'mcp') {
      entry.servers = held as Held<McpServer[]>
      entry.partial = false
    } else entry.commands = held as Held<ProviderCommand[]>
  }

  #entry(projectPath: string): Entry {
    let entry = this.#entries.get(projectPath)
    if (entry) {
      // Map order is the eviction order: the most recently used goes last.
      this.#entries.delete(projectPath)
    } else {
      entry = {
        partial: false,
        state: 'idle',
        probeStartedAt: 0,
        dirty: false,
        awaited: new Set(),
      }
    }
    this.#entries.set(projectPath, entry)
    this.#evict(projectPath)
    return entry
  }

  #evict(keep: string): void {
    for (const [projectPath, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxProjects) return
      if (entry.state === 'idle' && projectPath !== keep) this.#entries.delete(projectPath)
    }
  }

  #enqueue(projectPath: string, entry: Entry): void {
    entry.state = 'queued'
    this.#queue.push(projectPath)
    this.#pump()
  }

  #unqueue(projectPath: string): void {
    const index = this.#queue.indexOf(projectPath)
    if (index >= 0) this.#queue.splice(index, 1)
  }

  /** One probe at a time: each starts a full agent with all of its MCP servers. */
  #pump(): void {
    if (this.#running) return
    let projectPath: string | undefined
    let entry: Entry | undefined
    while (!entry) {
      projectPath = this.#queue.shift()
      if (projectPath === undefined) return
      entry = this.#entries.get(projectPath)
      // A project forgotten while it waited has nothing to probe.
      if (entry?.state !== 'queued') entry = undefined
    }
    this.#probe(projectPath!, entry)
  }

  #probe(projectPath: string, entry: Entry): void {
    const abort = new AbortController()
    entry.state = 'probing'
    entry.abort = abort
    entry.dirty = false
    entry.probeStartedAt = Date.now()
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs)
    timer.unref?.()
    const running = { projectPath, timer }
    this.#running = running
    const current = () => this.#entries.get(projectPath) === entry && entry.abort === abort
    void Promise.resolve()
      .then(() =>
        this.#options.service.discover(projectPath, {
          signal: abort.signal,
          onUpdate: (inventory) => {
            if (current() && !abort.signal.aborted) this.#update(projectPath, entry, inventory)
          },
        }),
      )
      .then(
        (inventory) => {
          if (current()) this.#finish(projectPath, entry, inventory)
        },
        (error: unknown) => {
          if (!current()) return
          this.#options.onError?.(projectPath, error)
          this.#finish(projectPath, entry, undefined)
        },
      )
      .finally(() => {
        clearTimeout(timer)
        if (this.#running === running) {
          this.#running = undefined
          this.#pump()
        }
      })
  }

  #update(projectPath: string, entry: Entry, inventory: ProjectInventory): void {
    const changed = this.#apply(entry, inventory, Date.now())
    entry.partial = true
    for (const part of changed) entry.awaited.delete(part)
    if (changed.length) this.#options.onChanged(projectPath, changed)
  }

  #finish(projectPath: string, entry: Entry, inventory: ProjectInventory | undefined): void {
    entry.state = 'idle'
    entry.abort = undefined
    entry.partial = false
    const changed = new Set<ProjectInventoryPart>(entry.awaited)
    entry.awaited.clear()
    if (inventory) {
      entry.failedAt = undefined
      // A change during the probe may not be in its answer; the next read refreshes.
      for (const part of this.#apply(entry, inventory, entry.dirty ? 0 : Date.now()))
        changed.add(part)
    } else if (!entry.commands && !entry.servers) entry.failedAt = Date.now()
    entry.dirty = false
    if (changed.size) this.#options.onChanged(projectPath, [...changed])
  }

  /** Stores a probe answer; a live chat's answer that arrived during the probe wins. */
  #apply(entry: Entry, inventory: ProjectInventory, at: number): ProjectInventoryPart[] {
    const changed: ProjectInventoryPart[] = []
    const newer = (held: Held<unknown> | undefined) =>
      held?.live === true && held.at >= entry.probeStartedAt
    if (!newer(entry.commands)) {
      if (!same(entry.commands?.value, inventory.commands)) changed.push('commands')
      entry.commands = { value: inventory.commands, at, live: false }
    }
    if (!newer(entry.servers)) {
      if (!same(entry.servers?.value, inventory.servers)) changed.push('mcp')
      entry.servers = { value: inventory.servers, at, live: false }
    }
    return changed
  }
}

function same(previous: unknown, next: unknown): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)
}
