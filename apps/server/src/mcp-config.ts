import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  JsonValueSchema,
  McpServerConfigSchema,
  ProviderIdSchema,
  type McpServerConfig,
  type ProviderId,
} from '@harness/contracts'
import { z } from 'zod'
import { configFile } from './product-paths.js'

type ConfigFile = {
  version: 1
  projects: Record<string, Partial<Record<ProviderId, Record<string, McpServerConfig>>>>
}

type ParsedConfig = { config: ConfigFile; skipped: boolean }
type CachedConfig = {
  config: ConfigFile
  stamp: string | undefined
  checkedAt: number
}

const EMPTY_CONFIG: ConfigFile = { version: 1, projects: {} }
const CACHE_RECHECK_MS = 100
const PROJECT_PATH_CACHE_LIMIT = 256
const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
const StoredConfigSchema = z.object({
  version: z.literal(1),
  projects: JsonObjectSchema,
})

function defaultLocation(): string {
  return configFile('mcp.json')
}

function canonicalProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath)
  const resolved = existsSync(absolute) ? realpathSync.native(absolute) : absolute
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function configFileStamp(location: string): string {
  const stats = statSync(location, { bigint: true, throwIfNoEntry: false })
  if (!stats) return 'missing'
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

function parseConfig(raw: string): ParsedConfig {
  const parsed = StoredConfigSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error('invalid MCP config: expected a version 1 project map')
  }
  const value = parsed.data
  let skipped = false

  // One malformed entry must not take the whole file down: throwing here
  // made every MCP operation fail, which also removed the only way to repair
  // the file from inside the app. Invalid entries are skipped and logged;
  // the next write persists the sanitised shape.
  const projects: ConfigFile['projects'] = {}
  for (const [projectPath, providersValue] of Object.entries(value.projects)) {
    const parsedProviders = JsonObjectSchema.safeParse(providersValue)
    if (!parsedProviders.success) {
      skipped = true
      console.warn(`[mcp-config] skipping invalid project entry "${projectPath}"`)
      continue
    }
    const providers: ConfigFile['projects'][string] = {}
    for (const [providerName, serversValue] of Object.entries(parsedProviders.data)) {
      const provider = ProviderIdSchema.safeParse(providerName)
      const parsedServers = JsonObjectSchema.safeParse(serversValue)
      if (!provider.success || !parsedServers.success) {
        skipped = true
        console.warn(
          `[mcp-config] skipping invalid provider "${providerName}" for "${projectPath}"`,
        )
        continue
      }
      const servers: Record<string, McpServerConfig> = {}
      for (const [serverId, serverValue] of Object.entries(parsedServers.data)) {
        const server = McpServerConfigSchema.safeParse(serverValue)
        if (!server.success || server.data.id !== serverId) {
          skipped = true
          console.warn(`[mcp-config] skipping invalid server "${serverId}" for "${projectPath}"`)
          continue
        }
        servers[serverId] = server.data
      }
      providers[provider.data] = servers
    }
    projects[projectPath] = providers
  }
  return { config: { version: 1, projects }, skipped }
}

/** Human-readable project MCP definitions. Secret values never enter this file. */
export class McpConfigStore {
  #cachedConfig: CachedConfig | undefined
  #canonicalProjectPaths = new Map<string, { path: string; checkedAt: number }>()

  constructor(
    private readonly location = defaultLocation(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  list(provider: ProviderId, projectPath: string): McpServerConfig[] {
    return Object.values(this.#read().projects[this.#projectPath(projectPath)]?.[provider] ?? {})
  }

  add(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    const file = structuredClone(this.#read(true))
    const servers = this.#servers(file, provider, projectPath)
    if (servers[server.id]) throw new Error(`project MCP server "${server.id}" already exists`)
    servers[server.id] = structuredClone(server)
    this.#write(file)
  }

  update(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    const file = structuredClone(this.#read(true))
    const servers = this.#servers(file, provider, projectPath)
    if (!servers[server.id]) throw new Error(`project MCP server "${server.id}" does not exist`)
    servers[server.id] = structuredClone(server)
    this.#write(file)
  }

  remove(provider: ProviderId, projectPath: string, serverId: string): void {
    const file = structuredClone(this.#read(true))
    const projectKey = this.#projectPath(projectPath, true)
    const servers = file.projects[projectKey]?.[provider]
    if (!servers?.[serverId]) throw new Error(`project MCP server "${serverId}" does not exist`)
    delete servers[serverId]
    if (Object.keys(servers).length === 0) delete file.projects[projectKey]?.[provider]
    if (Object.keys(file.projects[projectKey] ?? {}).length === 0) delete file.projects[projectKey]
    this.#write(file)
  }

  #servers(
    file: ConfigFile,
    provider: ProviderId,
    projectPath: string,
  ): Record<string, McpServerConfig> {
    const projectKey = this.#projectPath(projectPath, true)
    const project = (file.projects[projectKey] ??= {})
    return (project[provider] ??= {})
  }

  /** Set when the last read skipped entries; the original must be kept. */
  #readLossy = false

  #read(force = false): ConfigFile {
    const checkedAt = this.now()
    if (
      !force &&
      this.#cachedConfig &&
      checkedAt >= this.#cachedConfig.checkedAt &&
      checkedAt - this.#cachedConfig.checkedAt < CACHE_RECHECK_MS
    ) {
      return this.#cachedConfig.config
    }
    const stamp = configFileStamp(this.location)
    if (this.#cachedConfig?.stamp === stamp) {
      this.#cachedConfig.checkedAt = checkedAt
      return this.#cachedConfig.config
    }
    if (stamp === 'missing') {
      this.#readLossy = false
      return this.#cache(structuredClone(EMPTY_CONFIG), stamp, checkedAt)
    }
    const raw = readFileSync(this.location, 'utf8')
    const parsed = parseConfig(raw)
    this.#readLossy = parsed.skipped
    return this.#cache(parsed.config, stamp, checkedAt)
  }

  #write(file: ConfigFile): void {
    mkdirSync(path.dirname(this.location), { recursive: true })
    // A hand-edited file with entries we could not parse is not ours to
    // destroy — park the original next to the sanitised rewrite.
    if (this.#readLossy && existsSync(this.location)) {
      renameSync(this.location, `${this.location}.invalid-${Date.now()}.bak`)
      this.#readLossy = false
    }
    const temporary = `${this.location}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temporary, this.location)
      let stamp: string | undefined
      try {
        stamp = configFileStamp(this.location)
      } catch {
        // The write succeeded. A later read can establish the signature.
      }
      this.#cache(file, stamp, this.now())
    } catch (error) {
      // A failed atomic write (disk full, AV holding the handle) must not
      // leave a stray .tmp behind on every retry.
      rmSync(temporary, { force: true })
      throw error
    }
  }

  #cache(config: ConfigFile, stamp: string | undefined, checkedAt: number): ConfigFile {
    const frozen = deepFreeze(config)
    this.#cachedConfig = { config: frozen, stamp, checkedAt }
    return frozen
  }

  #projectPath(projectPath: string, force = false): string {
    const checkedAt = this.now()
    const cached = this.#canonicalProjectPaths.get(projectPath)
    if (
      !force &&
      cached &&
      checkedAt >= cached.checkedAt &&
      checkedAt - cached.checkedAt < CACHE_RECHECK_MS
    ) {
      return cached.path
    }
    const resolved = canonicalProjectPath(projectPath)
    if (
      !this.#canonicalProjectPaths.has(projectPath) &&
      this.#canonicalProjectPaths.size >= PROJECT_PATH_CACHE_LIMIT
    ) {
      const oldest = this.#canonicalProjectPaths.keys().next().value
      if (oldest !== undefined) this.#canonicalProjectPaths.delete(oldest)
    }
    this.#canonicalProjectPaths.set(projectPath, { path: resolved, checkedAt })
    return resolved
  }
}
