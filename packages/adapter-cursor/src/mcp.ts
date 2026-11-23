import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpConfigValue, McpServerConfig } from '@harness/contracts'
import { createHttpMcpBridgeLaunch } from '@harness/proc/mcp-stdio-bridge'

export type CursorMcpPlugin = {
  readonly dir: string
  readonly env: Record<string, string>
  dispose(): void
}

/** Cursor's `--plugin-dir` can only add servers, so reject project hide overrides. */
export function validateCursorMcpServer(
  server: McpServerConfig,
): asserts server is Extract<McpServerConfig, { enabled: true }> {
  if (!server.enabled) {
    throw new Error(
      `MCP server "${server.id}" cannot be hidden through Cursor. Remove this project override and manage that server in Cursor's own configuration.`,
    )
  }
}

function resolveMcpValue(value: McpConfigValue, credentials: Record<string, string>): string {
  if (value.source === 'literal') return value.value
  const credential = credentials[value.credentialRef]
  if (credential === undefined) {
    throw new Error(`MCP credential "${value.credentialRef}" is unavailable`)
  }
  return credential
}

/**
 * Materializes a temporary `--plugin-dir` bundle for `cursor-agent`.
 *
 * Credentials never touch disk: HTTP servers run through the shared
 * stdio-to-HTTP bridge with URL and headers in child env, and stdio server
 * credentials are passed through the spawned process's inherited env.
 */
export function prepareCursorMcpPlugin(
  servers: readonly McpServerConfig[],
  credentials: Record<string, string>,
): CursorMcpPlugin | undefined {
  const enabled = servers.filter((server) => server.enabled)
  if (enabled.length === 0) return undefined

  const mcpServers: Record<
    string,
    { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  > = {}
  const env: Record<string, string> = {}

  for (const server of enabled) {
    validateCursorMcpServer(server)
    const transport = server.transport
    if (transport.type === 'http') {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(transport.headers ?? {})) {
        headers[name] = resolveMcpValue(value, credentials)
      }
      const bridge = createHttpMcpBridgeLaunch({ url: transport.url, headers })
      mcpServers[server.id] = { command: bridge.command, args: bridge.args }
      Object.assign(env, bridge.env)
      continue
    }
    const literalEnv: Record<string, string> = {}
    for (const [name, value] of Object.entries(transport.environment ?? {})) {
      if (value.source === 'literal') {
        literalEnv[name] = value.value
      } else {
        env[name] = resolveMcpValue(value, credentials)
      }
    }
    mcpServers[server.id] = {
      command: transport.command,
      ...(transport.args?.length ? { args: transport.args } : {}),
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      ...(Object.keys(literalEnv).length > 0 ? { env: literalEnv } : {}),
    }
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tastecode-cursor-mcp-'))
  try {
    mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true })
    writeFileSync(
      path.join(dir, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'tastecode',
        version: '0.0.1',
        description: 'TasteCode managed MCP servers',
        mcpServers: './.mcp.json',
      }),
      { encoding: 'utf8', mode: 0o600 },
    )
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers }), {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }

  let disposed = false
  return {
    dir,
    env,
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best-effort temp cleanup.
      }
    },
  }
}
