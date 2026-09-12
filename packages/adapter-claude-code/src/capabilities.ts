import type { Capabilities, McpServerConfig } from '@harness/contracts'

/** Keep unsupported provider operations out of saved project configuration too. */
export function validateClaudeMcpServer(
  server: McpServerConfig,
): asserts server is Extract<McpServerConfig, { enabled: true }> {
  if (!server.enabled)
    throw new Error(
      'Claude Code cannot hide an inherited MCP server without changing its own configuration. Remove this project override and manage that server in Claude Code.',
    )
  // The SDK copies names into ordinary objects; this name cannot survive that copy.
  if (server.id === '__proto__')
    throw new Error('Claude Code cannot use the MCP server id "__proto__". Choose another id.')
  if (!/^[A-Za-z0-9_-]+$/.test(server.id))
    throw new Error(
      'Claude Code MCP server ids can contain only letters, numbers, hyphens, and underscores.',
    )
  if (server.transport.type === 'stdio' && server.transport.cwd)
    throw new Error(
      `Claude Code MCP server "${server.id}" cannot use a custom working directory. Remove it to use the project directory.`,
    )
}

export const CLAUDE_CAPABILITIES: Capabilities = {
  steer: true,
  fork: false,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  userInput: true,
  autoReview: true,
  images: true,
}
