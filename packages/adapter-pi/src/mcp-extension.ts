import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpConfigValue, McpServerConfig } from '@harness/contracts'

export type PiMcpExtension = {
  readonly file: string
  readonly env: Record<string, string>
}

/**
 * Self-contained Pi extension that bridges HTTP MCP servers (such as
 * TasteCode's local `tastecode` agent-tools endpoint) into `pi.registerTool`.
 * Holds no URLs or credentials: everything travels through `process.env`.
 */
export const PI_MCP_EXTENSION_SCRIPT = [
  'export default async function (pi) {',
  '  const raw = process.env.TASTECODE_PI_MCP_SERVERS',
  '  if (!raw) return',
  '  let specs = []',
  '  try {',
  '    const parsed = JSON.parse(raw)',
  '    if (Array.isArray(parsed)) specs = parsed',
  '  } catch { return }',
  '  let nextId = 1',
  '  const registered = new Set()',
  '  for (const spec of specs) {',
  '    const url = spec?.urlEnv ? process.env[spec.urlEnv] : undefined',
  '    if (!url) continue',
  '    let extraHeaders = {}',
  '    const rawHeaders = spec?.headersEnv ? process.env[spec.headersEnv] : undefined',
  '    if (rawHeaders) {',
  '      try {',
  '        const parsed = JSON.parse(rawHeaders)',
  '        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraHeaders = parsed',
  '      } catch {}',
  '    }',
  '    async function rpc(method, params, notify, signal) {',
  '      const payload = notify',
  '        ? { jsonrpc: "2.0", method, params }',
  '        : { jsonrpc: "2.0", id: nextId++, method, params }',
  '      const response = await fetch(url, {',
  '        method: "POST",',
  '        headers: {',
  '          ...extraHeaders,',
  '          "content-type": "application/json",',
  '          accept: "application/json",',
  '        },',
  '        body: JSON.stringify(payload),',
  '        ...(signal ? { signal } : {}),',
  '      })',
  '      if (notify || response.status === 202 || response.status === 204) return null',
  '      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)',
  '      return response.json()',
  '    }',
  '    try {',
  '      await rpc("initialize", {',
  '        protocolVersion: "2025-11-25",',
  '        capabilities: {},',
  '        clientInfo: { name: "tastecode-pi", version: "1.0.0" },',
  '      }, false)',
  '      await rpc("notifications/initialized", {}, true)',
  '      const listed = await rpc("tools/list", {}, false)',
  '      const tools = Array.isArray(listed?.result?.tools) ? listed.result.tools : []',
  '      for (const tool of tools) {',
  '        if (!tool || typeof tool.name !== "string" || !tool.name) continue',
  '        const exposed = registered.has(tool.name) ? `${spec.id}_${tool.name}` : tool.name',
  '        registered.add(exposed)',
  '        pi.registerTool({',
  '          name: exposed,',
  '          label: tool.name,',
  '          description: typeof tool.description === "string" && tool.description ? tool.description : tool.name,',
  '          parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },',
  '          async execute(_toolCallId, params, signal) {',
  '            const answer = await rpc("tools/call", { name: tool.name, arguments: params ?? {} }, false, signal)',
  '            if (answer?.error) {',
  '              return { content: [{ type: "text", text: String(answer.error.message || "Tool call failed") }], details: {}, isError: true }',
  '            }',
  '            const result = answer?.result ?? {}',
  '            const content = Array.isArray(result.content) && result.content.length > 0 ? result.content : [{ type: "text", text: "" }]',
  '            return { content, details: {}, ...(result.isError ? { isError: true } : {}) }',
  '          },',
  '        })',
  '      }',
  '    } catch {',
  '      // One unreachable MCP server must not prevent Pi from starting.',
  '    }',
  '  }',
  '}',
].join('\n')

let cachedExtension: { directory: string; file: string } | undefined

function ensurePiMcpExtensionScript(): string {
  if (cachedExtension) return cachedExtension.file
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tastecode-pi-mcp-'))
  const file = path.join(directory, 'mcp-extension.mjs')
  writeFileSync(file, `${PI_MCP_EXTENSION_SCRIPT}\n`, { encoding: 'utf8', mode: 0o600 })
  cachedExtension = { directory, file }
  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Best-effort temp cleanup on exit.
    }
  })
  return file
}

function resolveMcpValue(value: McpConfigValue, credentials: Record<string, string>): string {
  if (value.source === 'literal') return value.value
  const credential = credentials[value.credentialRef]
  if (credential === undefined) {
    throw new Error(`MCP credential "${value.credentialRef}" is unavailable`)
  }
  return credential
}

export function preparePiMcpExtension(
  servers: readonly McpServerConfig[],
  credentials: Record<string, string>,
): PiMcpExtension | undefined {
  const httpServers = servers.filter(
    (server): server is Extract<McpServerConfig, { enabled: true }> =>
      server.enabled && server.transport.type === 'http',
  )
  if (httpServers.length === 0) return undefined

  const specs: Array<{ id: string; urlEnv: string; headersEnv?: string }> = []
  const env: Record<string, string> = {}

  for (let index = 0; index < httpServers.length; index += 1) {
    const server = httpServers[index]!
    if (server.transport.type !== 'http') continue
    const urlEnv = `TASTECODE_PI_MCP_${index}_URL`
    env[urlEnv] = server.transport.url
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(server.transport.headers ?? {})) {
      headers[name] = resolveMcpValue(value, credentials)
    }
    if (Object.keys(headers).length > 0) {
      const headersEnv = `TASTECODE_PI_MCP_${index}_HEADERS`
      env[headersEnv] = JSON.stringify(headers)
      specs.push({ id: server.id, urlEnv, headersEnv })
    } else {
      specs.push({ id: server.id, urlEnv })
    }
  }

  env['TASTECODE_PI_MCP_SERVERS'] = JSON.stringify(specs)
  return { file: ensurePiMcpExtensionScript(), env }
}
