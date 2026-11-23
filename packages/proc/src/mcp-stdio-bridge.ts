import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type HttpMcpBridgeTarget = {
  url: string
  headers?: Record<string, string> | undefined
}

export type HttpMcpBridgeLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Self-contained stdio-to-HTTP MCP JSON-RPC bridge. Holds no URLs or secrets:
 * the parent passes them only through the child's environment under the prefix
 * named in `process.argv[2]`.
 */
export const HTTP_MCP_BRIDGE_SCRIPT = [
  "import readline from 'node:readline'",
  'const prefix = process.argv[2]',
  'const url = prefix ? process.env[`${prefix}_URL`] : undefined',
  'const rawHeaders = prefix ? process.env[`${prefix}_HEADERS`] : undefined',
  'let extraHeaders = {}',
  'if (rawHeaders) {',
  '  try {',
  '    const parsed = JSON.parse(rawHeaders)',
  '    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraHeaders = parsed',
  '  } catch {}',
  '}',
  'if (!url) process.exit(1)',
  'const inflight = new Set()',
  'let closing = false',
  'function send(value) {',
  '  if (closing) return',
  '  process.stdout.write(`${JSON.stringify(value)}\\n`)',
  '}',
  'function sendRaw(line) {',
  '  if (closing) return',
  '  const trimmed = line.trim()',
  '  if (trimmed) process.stdout.write(`${trimmed}\\n`)',
  '}',
  'function extractId(raw) {',
  '  try {',
  '    const parsed = JSON.parse(raw)',
  '    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "id" in parsed) {',
  '      return parsed.id',
  '    }',
  '  } catch {}',
  '  return undefined',
  '}',
  'async function forward(raw) {',
  '  const id = extractId(raw)',
  '  const controller = new AbortController()',
  '  inflight.add(controller)',
  '  try {',
  '    const response = await fetch(url, {',
  '      method: "POST",',
  '      headers: {',
  '        ...extraHeaders,',
  '        "content-type": "application/json",',
  '        accept: "application/json, text/event-stream",',
  '      },',
  '      body: raw,',
  '      signal: controller.signal,',
  '    })',
  '    if (response.status === 202 || response.status === 204) return',
  '    if (!response.ok) {',
  '      if (id !== undefined) {',
  '        send({ jsonrpc: "2.0", id, error: { code: -32603, message: `HTTP ${response.status}` } })',
  '      }',
  '      return',
  '    }',
  '    const contentType = response.headers.get("content-type") || ""',
  '    const body = await response.text()',
  '    if (!body.trim()) return',
  '    if (contentType.includes("text/event-stream")) {',
  '      let data = []',
  '      for (const line of body.split(/\\r?\\n/)) {',
  '        if (line.startsWith("data:")) {',
  '          data.push(line.slice(5).trimStart())',
  '        } else if (line === "" && data.length > 0) {',
  '          const payload = data.join("\\n").trim()',
  '          data = []',
  '          if (payload && payload !== "[DONE]") sendRaw(payload)',
  '        }',
  '      }',
  '      if (data.length > 0) {',
  '        const payload = data.join("\\n").trim()',
  '        if (payload && payload !== "[DONE]") sendRaw(payload)',
  '      }',
  '      return',
  '    }',
  '    try {',
  '      const parsed = JSON.parse(body)',
  '      send(parsed)',
  '    } catch {',
  '      sendRaw(body)',
  '    }',
  '  } catch (error) {',
  '    if (closing || controller.signal.aborted) return',
  '    if (id !== undefined) {',
  '      const message = error instanceof Error ? error.message : String(error)',
  '      send({ jsonrpc: "2.0", id, error: { code: -32603, message } })',
  '    }',
  '  } finally {',
  '    inflight.delete(controller)',
  '  }',
  '}',
  'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })',
  'rl.on("line", (line) => {',
  '  const trimmed = line.trim()',
  '  if (!trimmed) return',
  '  void forward(trimmed)',
  '})',
  'rl.on("close", () => {',
  '  closing = true',
  '  for (const controller of inflight) controller.abort()',
  '  inflight.clear()',
  '})',
].join('\n')

let cachedScript: { directory: string; file: string } | undefined

/**
 * Materializes the bridge script once on real disk outside any `.asar` archive
 * so external CLIs and `process.execPath` can execute it on every OS.
 */
export function ensureHttpMcpBridgeScript(): string {
  if (cachedScript) return cachedScript.file
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tastecode-mcp-bridge-'))
  const file = path.join(directory, 'mcp-stdio-bridge.mjs')
  writeFileSync(file, `${HTTP_MCP_BRIDGE_SCRIPT}\n`, { encoding: 'utf8', mode: 0o600 })
  cachedScript = { directory, file }
  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Best-effort temp cleanup on process exit.
    }
  })
  return file
}

let nextPrefixId = 0

/**
 * Builds a stdio launch that bridges one HTTP MCP endpoint using Node (or the
 * packaged Electron binary with `ELECTRON_RUN_AS_NODE=1`). Credentials travel
 * only in `env`, never on disk or in `args`.
 */
export function createHttpMcpBridgeLaunch(
  target: HttpMcpBridgeTarget,
  options: { envPrefix?: string } = {},
): HttpMcpBridgeLaunch {
  const prefix = options.envPrefix ?? `TASTECODE_MCP_BRIDGE_${++nextPrefixId}`
  const script = ensureHttpMcpBridgeScript()
  const headers = target.headers ?? {}
  return {
    command: process.execPath,
    args: [script, prefix],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      [`${prefix}_URL`]: target.url,
      ...(Object.keys(headers).length > 0 ? { [`${prefix}_HEADERS`]: JSON.stringify(headers) } : {}),
    },
  }
}
