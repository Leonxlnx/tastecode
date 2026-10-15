import type { McpConfigValue, McpServerConfig } from '@harness/contracts'

export type AcpMcpServer =
  | {
      name: string
      command: string
      args: string[]
      env: Array<{ name: string; value: string }>
    }
  | {
      type: 'http'
      name: string
      url: string
      headers: Array<{ name: string; value: string }>
    }

/** ACP sessions can only add servers, so reject saves the launch could not honor. */
export function validateAcpMcpServer(
  server: McpServerConfig,
): asserts server is Extract<McpServerConfig, { enabled: true }> {
  if (!server.enabled)
    throw new Error(
      `MCP server "${server.id}" cannot be hidden through ACP. Remove this project override and manage that server in the agent's own configuration.`,
    )
  if (server.transport.type === 'stdio' && server.transport.cwd)
    throw new Error(
      `MCP server "${server.id}" cannot use a custom working directory through ACP. Remove it to use the project directory.`,
    )
}

/** Translate TasteCode's credential-safe config into the ACP session shape. */
export function prepareAcpMcpServers(
  servers: McpServerConfig[],
  credentials: Record<string, string>,
): AcpMcpServer[] {
  const result: AcpMcpServer[] = []
  for (const server of servers) {
    // Hide records saved before validation existed must not block every launch.
    if (!server.enabled) continue
    validateAcpMcpServer(server)
    const transport = server.transport
    if (transport.type === 'stdio') {
      result.push({
        name: server.id,
        command: transport.command,
        args: transport.args ?? [],
        env: Object.entries(transport.environment ?? {}).map(([name, value]) => ({
          name,
          value: resolveMcpValue(value, credentials),
        })),
      })
      continue
    }
    result.push({
      type: 'http',
      name: server.id,
      url: transport.url,
      headers: Object.entries(transport.headers ?? {}).map(([name, value]) => ({
        name,
        value: resolveMcpValue(value, credentials),
      })),
    })
  }
  return result
}

function resolveMcpValue(value: McpConfigValue, credentials: Record<string, string>): string {
  if (value.source === 'literal') return value.value
  const credential = credentials[value.credentialRef]
  if (credential === undefined) {
    throw new Error(`MCP credential "${value.credentialRef}" is unavailable`)
  }
  return credential
}
