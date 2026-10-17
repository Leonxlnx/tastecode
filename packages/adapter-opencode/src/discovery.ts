import type { McpServer, ProviderCommand, Skill } from '@harness/contracts'
import { OpenCodeAdapter } from './adapter.js'

/** What OpenCode loads for a project: its commands and skills, and its MCP servers. */
export type OpenCodeProjectInventory = {
  commands: ProviderCommand[]
  servers: McpServer[]
  skills: Skill[]
}

/** The part of the adapter a probe uses; tests answer it with captured routes. */
export type OpenCodeInventoryReader = Pick<
  OpenCodeAdapter,
  'start' | 'dispose' | 'commands' | 'skills' | 'mcpServers'
>

export type OpenCodeProjectDiscoveryOptions = {
  signal?: AbortSignal | undefined
  /** Commands and skills arrived while MCP servers still connect; the final answer follows. */
  onUpdate?: ((inventory: OpenCodeProjectInventory) => void) | undefined
  createReader?: () => OpenCodeInventoryReader
}

/**
 * Starts `opencode serve` without a session and reads what it loads for the
 * project. Nothing is sent, so nothing is billed, and the server is stopped
 * before this returns. Commands and skills answer in about a second; `/mcp`
 * waits until the project's servers have connected.
 */
export async function discoverOpenCodeProject(
  projectPath: string,
  options: OpenCodeProjectDiscoveryOptions = {},
): Promise<OpenCodeProjectInventory> {
  options.signal?.throwIfAborted()
  const reader = (options.createReader ?? (() => new OpenCodeAdapter()))()
  // Stopping the server ends every read still in flight.
  const stop = () => void reader.dispose().catch(() => undefined)
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    await reader.start()
    options.signal?.throwIfAborted()
    let connected = false
    const servers = reader.mcpServers(projectPath).finally(() => {
      connected = true
    })
    // Settled here so a failed command read cannot leave this rejection unhandled.
    servers.catch(() => undefined)
    const [commands, skills] = await Promise.all([
      reader.commands(projectPath),
      reader.skills(projectPath),
    ])
    options.signal?.throwIfAborted()
    if (!connected) options.onUpdate?.({ commands, servers: [], skills })
    const inventory = { commands, servers: await servers, skills }
    options.signal?.throwIfAborted()
    return inventory
  } finally {
    options.signal?.removeEventListener('abort', stop)
    await reader.dispose()
  }
}
