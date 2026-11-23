import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServerConfig } from '@harness/contracts'
import { z } from 'zod'
import type { SimulatorService } from './service.js'

export const SIMULATOR_MCP_PATH = '/mcp'
export const SIMULATOR_MCP_SERVER_ID = 'tastecode-simulator'
const MAX_BODY_BYTES = 256 * 1024
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
])

export const SIMULATOR_AGENT_INSTRUCTIONS = [
  '## Simulator tools',
  'For iOS Simulator and Android Emulator UI work (launching apps, tapping, typing, reading screen hierarchy, changing appearance/permissions, taking screenshots so the user can watch live in the Simulator panel), use the `device_list`, `device_open`, `device_screenshot`, and `device_close` MCP tools.',
  'If your tool harness defers MCP tools behind tool search, load `device_list`, `device_open`, `device_screenshot`, and `device_close` first.',
  'Call `device_list` to discover available simulators/emulators and `device_open` to boot and attach one to the Simulator panel. `device_open` returns a bound `agent-device` command path and quick-start guide — drive every UI interaction through that command rather than raw `simctl` or `adb` UI commands. Keep `simctl`, `adb`, Xcode, Gradle, and Metro for builds, installs, logs, and test runners.',
].join('\n')

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

const DeviceListArgsSchema = z.object({}).strict().default({})

const DeviceOpenArgsSchema = z
  .object({
    deviceId: z.string().min(1).optional(),
    platform: z.enum(['ios', 'android']).optional(),
  })
  .strict()
  .default({})

const DeviceScreenshotArgsSchema = z
  .object({
    deviceId: z.string().min(1).optional(),
  })
  .strict()
  .default({})

const DeviceCloseArgsSchema = z
  .object({
    deviceId: z.string().min(1).optional(),
    shutdown: z.boolean().optional(),
  })
  .strict()
  .default({})

const MCP_TOOLS = [
  {
    name: 'device_list',
    description:
      "List local iOS Simulators and Android Emulators, platform availability, and which devices are currently open in this thread's Simulator panel. Call before `device_open` when you do not know a device id.",
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: 'List simulators',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'device_open',
    description:
      "Open a simulator or emulator for this thread. Pass `deviceId` (or `platform`) from `device_list`. Boots it if needed and shows it live in the user's Simulator panel. Returns the bound `agent-device` CLI path and quick-start guide to drive the device.",
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Simulator UDID or Android AVD/serial from `device_list`.',
        },
        platform: {
          type: 'string',
          enum: ['ios', 'android'],
          description: 'Platform to pick when `deviceId` is omitted.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Open simulator',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'device_screenshot',
    description:
      'Capture a PNG screenshot of an open simulator in this thread so you can inspect the screen visually. For taps, typing, and accessibility snapshots, use the `agent-device` CLI returned by `device_open`.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description:
            'Open device id. Defaults to the most recently opened device in this thread.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Screenshot simulator',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'device_close',
    description:
      "Close a simulator session in this thread's Simulator panel and release its agent-device session. Pass `shutdown: true` to also power off the simulator.",
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Device id to close. Omit to close all open simulators in this thread.',
        },
        shutdown: {
          type: 'boolean',
          description: 'When true, also shuts down the simulator or emulator.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Close simulator',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
] as const

export type PngDimensions = {
  readonly width: number
  readonly height: number
}

export function pngDimensions(png: Uint8Array): PngDimensions {
  if (png.length < 24) return { width: 0, height: 0 }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452
  return isPng ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: 0, height: 0 }
}

function parseBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1]
}

export class SimulatorMcpServer {
  #threadTokens = new Map<string, string>()
  #sessions = new Set<string>()

  constructor(
    private readonly simulator: SimulatorService,
    private readonly serverOrigin: () => string,
  ) {}

  get enabled(): boolean {
    return this.simulator.agentAccessEnabled
  }

  /** Returns the per-thread built-in HTTP MCP config and its bearer credential. */
  mcpConfigForThread(threadId: string):
    | {
        readonly server: McpServerConfig
        readonly credentials: Record<string, string>
      }
    | undefined {
    if (!this.simulator.agentAccessEnabled) return undefined
    let token = this.#threadTokens.get(threadId)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      this.#threadTokens.set(threadId, token)
    }
    const credentialRef = `internal:simulator-mcp:${threadId}`
    return {
      server: {
        id: SIMULATOR_MCP_SERVER_ID,
        enabled: true,
        transport: {
          type: 'http',
          url: `${this.serverOrigin()}${SIMULATOR_MCP_PATH}`,
          headers: {
            Authorization: { source: 'credential', credentialRef },
          },
        },
      },
      credentials: {
        [credentialRef]: `Bearer ${token}`,
      },
    }
  }

  revokeThread(threadId: string): void {
    this.#threadTokens.delete(threadId)
  }

  /**
   * Re-associates a token created before `runtime.start()` returned the
   * provider's thread id with the final stored thread id.
   */
  rebindThread(fromId: string, toThreadId: string): void {
    if (fromId === toThreadId) return
    const token = this.#threadTokens.get(fromId)
    if (!token) return
    this.#threadTokens.delete(fromId)
    this.#threadTokens.set(toThreadId, token)
  }

  clear(): void {
    this.#threadTokens.clear()
    this.#sessions.clear()
  }

  #authenticate(header: string | undefined): string | undefined {
    const token = parseBearerToken(header)
    if (!token) return undefined
    const supplied = Buffer.from(token)
    for (const [threadId, expectedToken] of this.#threadTokens) {
      const expected = Buffer.from(expectedToken)
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
        return threadId
      }
    }
    return undefined
  }

  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = req.url?.split('?')[0]
    if (pathname !== SIMULATOR_MCP_PATH) return false

    // Loopback MCP is only for local agent runtimes, never browser pages.
    if (req.headers.origin !== undefined) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
      return true
    }

    const threadId = this.#authenticate(req.headers.authorization)
    if (!threadId) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('Unauthorized')
      return true
    }

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id']
      if (typeof sessionId === 'string') this.#sessions.delete(sessionId)
      res.writeHead(204).end()
      return true
    }

    if (req.method === 'GET') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end('Method Not Allowed')
      return true
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end('Method Not Allowed')
      return true
    }

    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buf.length
      if (bytes > MAX_BODY_BYTES) {
        res.writeHead(413).end('Payload Too Large')
        return true
      }
      chunks.push(buf)
    }

    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      )
      return true
    }

    const messages = Array.isArray(body) ? body : [body]
    const responses: unknown[] = []
    let sessionId =
      typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined

    for (const raw of messages) {
      const parsed = JsonRpcRequestSchema.safeParse(raw)
      if (!parsed.success) {
        responses.push({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        })
        continue
      }
      const message = parsed.data
      if (message.id === undefined) {
        // Notification (e.g. notifications/initialized)
        continue
      }

      if (message.method === 'initialize') {
        const params =
          typeof message.params === 'object' && message.params !== null
            ? (message.params as Record<string, unknown>)
            : {}
        const requested =
          typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-03-26'
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : '2025-03-26'
        sessionId = randomBytes(16).toString('hex')
        this.#sessions.add(sessionId)
        responses.push({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SIMULATOR_MCP_SERVER_ID, version: '1.0.0' },
          },
        })
        continue
      }

      if (message.method === 'ping') {
        responses.push({ jsonrpc: '2.0', id: message.id, result: {} })
        continue
      }

      if (message.method === 'tools/list') {
        responses.push({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: MCP_TOOLS },
        })
        continue
      }

      if (message.method === 'tools/call') {
        const callResult = await this.#handleToolCall(threadId, message.params)
        responses.push({
          jsonrpc: '2.0',
          id: message.id,
          result: callResult,
        })
        continue
      }

      responses.push({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      })
    }

    if (responses.length === 0) {
      res.writeHead(202).end()
      return true
    }

    const payload = Array.isArray(body) ? responses : responses[0]
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    if (sessionId) res.setHeader('mcp-session-id', sessionId)
    res.writeHead(200).end(JSON.stringify(payload))
    return true
  }

  async #handleToolCall(threadId: string, rawParams: unknown): Promise<Record<string, unknown>> {
    const params =
      typeof rawParams === 'object' && rawParams !== null
        ? (rawParams as Record<string, unknown>)
        : {}
    const name = typeof params['name'] === 'string' ? params['name'] : ''
    const rawArgs =
      params['arguments'] === undefined || params['arguments'] === null ? {} : params['arguments']

    const fail = (message: string) => ({
      isError: true,
      content: [{ type: 'text', text: message }],
    })

    if (!this.simulator.agentAccessEnabled) {
      return fail(
        'Agent simulator access is turned off. Ask the user to enable Simulator support and Agent simulator access in Settings → Simulator.',
      )
    }

    try {
      switch (name) {
        case 'device_list': {
          const parsed = DeviceListArgsSchema.safeParse(rawArgs)
          if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.message}`)
          const state = await this.simulator.list()
          const result = {
            hostStatus: state.hostStatus,
            ...(state.hostStatusDetail ? { hostStatusDetail: state.hostStatusDetail } : {}),
            platforms: state.platforms,
            devices: state.devices,
            open: state.sessions
              .filter((session) => session.threadId === threadId)
              .map((session) => ({ deviceId: session.deviceId, platform: session.platform })),
          }
          return {
            isError: false,
            structuredContent: result,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
        case 'device_open': {
          const parsed = DeviceOpenArgsSchema.safeParse(rawArgs)
          if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.message}`)
          const opened = await this.simulator.agentOpen({
            threadId,
            deviceId: parsed.data.deviceId,
            platform: parsed.data.platform,
          })
          return {
            isError: false,
            structuredContent: opened,
            content: [{ type: 'text', text: JSON.stringify(opened, null, 2) }],
          }
        }
        case 'device_screenshot': {
          const parsed = DeviceScreenshotArgsSchema.safeParse(rawArgs)
          if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.message}`)
          const shot = await this.simulator.agentScreenshot({
            threadId,
            deviceId: parsed.data.deviceId,
          })
          const dimensions = pngDimensions(shot.png)
          const metadata = {
            device: shot.device,
            screenshot: {
              mimeType: 'image/png',
              ...dimensions,
            },
          }
          return {
            isError: false,
            structuredContent: metadata,
            content: [
              { type: 'text', text: JSON.stringify(metadata) },
              {
                type: 'image',
                data: Buffer.from(shot.png).toString('base64'),
                mimeType: 'image/png',
              },
            ],
          }
        }
        case 'device_close': {
          const parsed = DeviceCloseArgsSchema.safeParse(rawArgs)
          if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.message}`)
          await this.simulator.close({
            threadId,
            deviceId: parsed.data.deviceId,
            shutdown: parsed.data.shutdown,
          })
          return {
            isError: false,
            structuredContent: {},
            content: [{ type: 'text', text: '{}' }],
          }
        }
        default:
          return fail(`Unknown tool: ${name}`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
}
