import type {
  McpAuth,
  McpCapabilities,
  McpServer,
  McpStartupStatus,
  McpTool,
} from '@harness/contracts'
import type { JsonValue } from './generated/serde_json/JsonValue.js'
import type { McpAuthStatus } from './generated/v2/McpAuthStatus.js'
import type { McpServerStatus } from './generated/v2/McpServerStatus.js'
import type { McpServerStatusUpdatedNotification } from './generated/v2/McpServerStatusUpdatedNotification.js'

export const CODEX_MCP_CAPABILITIES: McpCapabilities = {
  inventory: true,
  add: false,
  update: false,
  remove: false,
  reload: false,
  startOAuth: false,
  cancelOAuth: false,
}

function auth(status: McpAuthStatus): McpAuth {
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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as McpTool['inputSchema'])
    : undefined
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

export function mapMcpServerStatus(status: McpServerStatus, startup?: McpStartupStatus): McpServer {
  const displayName =
    status.serverInfo?.title ??
    (status.serverInfo?.name !== status.name ? status.serverInfo?.name : undefined)

  return {
    id: status.name,
    ...(displayName ? { displayName } : {}),
    ...(status.serverInfo?.description ? { description: status.serverInfo.description } : {}),
    ...(status.serverInfo?.version ? { version: status.serverInfo.version } : {}),
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
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
        },
      ]
    }),
    resources: status.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.title ? { title: resource.title } : {}),
      ...(resource.description !== undefined ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(Number.isSafeInteger(resource.size) && resource.size! >= 0
        ? { size: resource.size }
        : {}),
    })),
    resourceTemplates: status.resourceTemplates.map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      ...(template.title ? { title: template.title } : {}),
      ...(template.description !== undefined ? { description: template.description } : {}),
      ...(template.mimeType ? { mimeType: template.mimeType } : {}),
    })),
  }
}
