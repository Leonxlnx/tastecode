import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  McpServerConfigSchema,
  ProviderIdSchema,
  type McpServerConfig,
  type ProviderId,
} from '@harness/contracts'
import { configFile } from './product-paths.js'

type ConfigFile = {
  version: 1
  projects: Record<string, Partial<Record<ProviderId, Record<string, McpServerConfig>>>>
}

const EMPTY_CONFIG: ConfigFile = { version: 1, projects: {} }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultLocation(): string {
  return configFile('mcp.json')
}

function canonicalProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath)
  const resolved = existsSync(absolute) ? realpathSync.native(absolute) : absolute
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseConfig(raw: string): { config: ConfigFile; skipped: boolean } {
  const value: unknown = JSON.parse(raw)
  if (!isObject(value) || value['version'] !== 1 || !isObject(value['projects'])) {
    throw new Error('invalid MCP config: expected a version 1 project map')
  }
  let skipped = false

  // One malformed entry must not take the whole file down: throwing here
  // made every MCP operation fail, which also removed the only way to repair
  // the file from inside the app. Invalid entries are skipped and logged;
  // the next write persists the sanitised shape.
  const projects: ConfigFile['projects'] = {}
  for (const [projectPath, providersValue] of Object.entries(value['projects'])) {
    if (!isObject(providersValue)) {
      skipped = true
      console.warn(`[mcp-config] skipping invalid project entry "${projectPath}"`)
      continue
    }
    const providers: ConfigFile['projects'][string] = {}
    for (const [providerName, serversValue] of Object.entries(providersValue)) {
      const provider = ProviderIdSchema.safeParse(providerName)
      if (!provider.success || !isObject(serversValue)) {
        skipped = true
        console.warn(
          `[mcp-config] skipping invalid provider "${providerName}" for "${projectPath}"`,
        )
        continue
      }
      const servers: Record<string, McpServerConfig> = {}
      for (const [serverId, serverValue] of Object.entries(serversValue)) {
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
  constructor(private readonly location = defaultLocation()) {}

  list(provider: ProviderId, projectPath: string): McpServerConfig[] {
    return Object.values(this.#read().projects[canonicalProjectPath(projectPath)]?.[provider] ?? {})
  }

  add(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    const file = this.#read()
    const servers = this.#servers(file, provider, projectPath)
    if (servers[server.id]) throw new Error(`project MCP server "${server.id}" already exists`)
    servers[server.id] = server
    this.#write(file)
  }

  update(provider: ProviderId, projectPath: string, server: McpServerConfig): void {
    const file = this.#read()
    const servers = this.#servers(file, provider, projectPath)
    if (!servers[server.id]) throw new Error(`project MCP server "${server.id}" does not exist`)
    servers[server.id] = server
    this.#write(file)
  }

  remove(provider: ProviderId, projectPath: string, serverId: string): void {
    const file = this.#read()
    const projectKey = canonicalProjectPath(projectPath)
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
    const projectKey = canonicalProjectPath(projectPath)
    const project = (file.projects[projectKey] ??= {})
    return (project[provider] ??= {})
  }

  /** Set when the last read skipped entries; the original must be kept. */
  #readLossy = false

  #read(): ConfigFile {
    if (!existsSync(this.location)) return structuredClone(EMPTY_CONFIG)
    const raw = readFileSync(this.location, 'utf8')
    const parsed = parseConfig(raw)
    this.#readLossy = parsed.skipped
    return parsed.config
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
    } catch (error) {
      // A failed atomic write (disk full, AV holding the handle) must not
      // leave a stray .tmp behind on every retry.
      rmSync(temporary, { force: true })
      throw error
    }
  }
}
