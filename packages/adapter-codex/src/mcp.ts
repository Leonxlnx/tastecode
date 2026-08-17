import { createHash } from 'node:crypto'
import type {
  McpAuth,
  McpCapabilities,
  McpServer,
  McpServerConfig,
  McpStartupStatus,
  McpTool,
} from '@harness/contracts'
import type { JsonValue } from './generated/serde_json/JsonValue.js'
import { propertiesWhen } from './properties-when.js'
import {
  JsonObjectSchema,
  type McpServerStatusUpdatedNotification,
  type ParsedMcpServerStatus,
} from './schemas.js'

export const CODEX_MCP_CAPABILITIES: McpCapabilities = {
  inventory: true,
  add: true,
  update: true,
  remove: true,
  reload: true,
  startOAuth: true,
  cancelOAuth: false,
}

export type PreparedMcpConfig = {
  servers: Record<string, JsonValue>
  environment: NodeJS.ProcessEnv
}

export function prepareMcpConfig(
  servers: McpServerConfig[],
  credentials: Record<string, string>,
): PreparedMcpConfig {
  const result: Record<string, JsonValue> = {}
  const environment: NodeJS.ProcessEnv = {}
  const secret = (reference: string): string => {
    const value = credentials[reference]
    if (value === undefined) throw new Error(`MCP credential "${reference}" is unavailable`)
    return value
  }

  for (const server of servers) {
    if (!server.enabled) {
      result[server.id] = { enabled: false }
      continue
    }

    if (server.transport.type === 'stdio') {
      const env: Record<string, string> = {}
      for (const [name, value] of Object.entries(server.transport.environment ?? {})) {
        env[name] = value.source === 'literal' ? value.value : secret(value.credentialRef)
      }
      result[server.id] = {
        command: server.transport.command,
        enabled: true,
        ...propertiesWhen(server.transport.args, (includedValue) => ({ args: includedValue })),
        ...propertiesWhen(server.transport.cwd, (includedValue) => ({ cwd: includedValue })),
        ...propertiesWhen(Object.keys(env).length, () => ({ env })),
      }
      continue
    }

    const httpHeaders: Record<string, string> = {}
    const envHttpHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(server.transport.headers ?? {})) {
      if (value.source === 'literal') {
        httpHeaders[name] = value.value
      } else {
        const variable = `HARNESS_MCP_${createHash('sha256')
          .update(`${server.id}\0${name}`)
          .digest('hex')
          .slice(0, 16)
          .toUpperCase()}`
        environment[variable] = secret(value.credentialRef)
        envHttpHeaders[name] = variable
      }
    }
    result[server.id] = {
      url: server.transport.url,
      enabled: true,
      ...propertiesWhen(Object.keys(httpHeaders).length, () => ({ http_headers: httpHeaders })),
      ...propertiesWhen(Object.keys(envHttpHeaders).length, () => ({
        env_http_headers: envHttpHeaders,
      })),
    }
  }

  return { servers: result, environment }
}

function auth(status: ParsedMcpServerStatus['authStatus']): McpAuth {
  switch (status) {
    case 'notLoggedIn':
      return { status: 'sign_in_required', method: 'oauth' }
    case 'bearerToken':
      return { status: 'authenticated', method: 'bearer' }
    case 'oAuth':
      return { status: 'authenticated', method: 'oauth' }
    case 'unsupported':
      return { status: 'not_required' }
  }
}

function objectSchema(value: JsonValue | undefined): McpTool['inputSchema'] | undefined {
  const parsed = JsonObjectSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function mapMcpStartupStatus(status: McpServerStatusUpdatedNotification): McpStartupStatus {
  switch (status.status) {
    case 'starting':
      return { state: 'starting' }
    case 'ready':
      return { state: 'ready' }
    case 'cancelled':
      return { state: 'stopped' }
    case 'failed':
      return {
        state: 'failed',
        message:
          status.error ??
          (status.failureReason === 'reauthenticationRequired'
            ? 'Authentication required'
            : 'MCP server failed to start'),
      }
  }
}

export function mcpStartupInventory(
  startupByKey: ReadonlyMap<string, McpStartupStatus>,
  threadId?: string,
): McpServer[] {
  const prefix = `${threadId ?? ''}\0`
  return [...startupByKey.entries()].flatMap(([key, startup]) =>
    key.startsWith(prefix)
      ? [
          {
            id: key.slice(prefix.length),
            scope: 'global' as const,
            enabled: true,
            auth: { status: 'not_required' as const },
            startup,
            tools: [],
            resources: [],
            resourceTemplates: [],
          },
        ]
      : [],
  )
}

export function mapMcpServerStatus(
  status: ParsedMcpServerStatus,
  startup?: McpStartupStatus,
): McpServer {
  const displayName =
    status.serverInfo?.title ??
    (status.serverInfo?.name !== status.name ? status.serverInfo?.name : undefined)

  return {
    id: status.name,
    ...propertiesWhen(displayName, (displayName) => ({ displayName })),
    ...propertiesWhen(status.serverInfo?.description, (includedValue) => ({
      description: includedValue,
    })),
    ...propertiesWhen(status.serverInfo?.version, (includedValue) => ({ version: includedValue })),
    scope: 'global',
    enabled: true,
    auth: auth(status.authStatus),
    startup: startup ?? (status.serverInfo ? { state: 'ready' } : { state: 'stopped' }),
    tools: Object.values(status.tools).flatMap((tool) => {
      const inputSchema = tool && objectSchema(tool.inputSchema)
      if (!tool || !inputSchema) return []
      const outputSchema = objectSchema(tool.outputSchema)
      return [
        {
          name: tool.name,
          ...propertiesWhen(tool.title, (includedValue) => ({ title: includedValue })),
          ...propertiesWhen(tool.description !== undefined, () => ({
            description: tool.description,
          })),
          inputSchema,
          ...propertiesWhen(outputSchema, (outputSchema) => ({ outputSchema })),
        },
      ]
    }),
    resources: status.resources.map((resource) => {
      const size = resource.size
      return {
        uri: resource.uri,
        name: resource.name,
        ...propertiesWhen(resource.title, (includedValue) => ({ title: includedValue })),
        ...propertiesWhen(resource.description !== undefined, () => ({
          description: resource.description,
        })),
        ...propertiesWhen(resource.mimeType, (includedValue) => ({ mimeType: includedValue })),
        ...propertiesWhen(size !== undefined && Number.isSafeInteger(size) && size >= 0, () => ({
          size,
        })),
      }
    }),
    resourceTemplates: status.resourceTemplates.map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      ...propertiesWhen(template.title, (includedValue) => ({ title: includedValue })),
      ...propertiesWhen(template.description !== undefined, () => ({
        description: template.description,
      })),
      ...propertiesWhen(template.mimeType, (includedValue) => ({ mimeType: includedValue })),
    })),
  }
}
