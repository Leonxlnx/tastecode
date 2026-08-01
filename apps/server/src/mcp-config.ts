import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  McpServerConfigSchema,
  ProviderIdSchema,
  type McpServerConfig,
  type ProviderId,
} from '@harness/contracts'

type ConfigFile = {
  version: 1
  projects: Record<string, Partial<Record<ProviderId, Record<string, McpServerConfig>>>>
}

const EMPTY_CONFIG: ConfigFile = { version: 1, projects: {} }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultLocation(): string {
  const root = process.env['HARNESS_CONFIG_DIR'] ?? path.join(os.homedir(), '.personalharness')
  return path.join(root, 'mcp.json')
}

function canonicalProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath)
  const resolved = existsSync(absolute) ? realpathSync.native(absolute) : absolute
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseConfig(raw: string): ConfigFile {
  const value: unknown = JSON.parse(raw)
  if (!isObject(value) || value['version'] !== 1 || !isObject(value['projects'])) {
    throw new Error('invalid MCP config: expected a version 1 project map')
  }

  const projects: ConfigFile['projects'] = {}
  for (const [projectPath, providersValue] of Object.entries(value['projects'])) {
    if (!isObject(providersValue))
      throw new Error(`invalid MCP config for project "${projectPath}"`)
    const providers: ConfigFile['projects'][string] = {}
    for (const [providerName, serversValue] of Object.entries(providersValue)) {
      const provider = ProviderIdSchema.safeParse(providerName)
      if (!provider.success || !isObject(serversValue)) {
        throw new Error(`invalid MCP provider "${providerName}" for project "${projectPath}"`)
      }
      const servers: Record<string, McpServerConfig> = {}
      for (const [serverId, serverValue] of Object.entries(serversValue)) {
        const server = McpServerConfigSchema.safeParse(serverValue)
        if (!server.success || server.data.id !== serverId) {
          throw new Error(`invalid MCP server "${serverId}" for project "${projectPath}"`)
        }
        servers[serverId] = server.data
      }
      providers[provider.data] = servers
    }
    projects[projectPath] = providers
  }
  return { version: 1, projects }
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

  #read(): ConfigFile {
    return existsSync(this.location)
      ? parseConfig(readFileSync(this.location, 'utf8'))
      : structuredClone(EMPTY_CONFIG)
  }

  #write(file: ConfigFile): void {
    mkdirSync(path.dirname(this.location), { recursive: true })
    const temporary = `${this.location}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.location)
  }
}
