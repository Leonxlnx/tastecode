import { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { McpServerConfig } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { PiAdapter } from './adapter.js'
import { preparePiMcpExtension } from './mcp-extension.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    ),
  )
})

class FakePiChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdin = new PassThrough()
  override stdio: [PassThrough, PassThrough, PassThrough, null, null] = [
    this.stdin,
    this.stdout,
    this.stderr,
    null,
    null,
  ]
  #buf = ''
  constructor() {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.#buf += chunk
      let nl: number
      while ((nl = this.#buf.indexOf('\n')) !== -1) {
        const line = this.#buf.slice(0, nl).trim()
        this.#buf = this.#buf.slice(nl + 1)
        if (!line) continue
        const req = JSON.parse(line) as { id: string; type: string }
        if (req.type === 'get_state') {
          this.stdout.write(
            `${JSON.stringify({ id: req.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-1' } })}\n`,
          )
        }
      }
    })
  }
  override kill(): boolean {
    setImmediate(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', 0, null)
      this.emit('close', 0)
    })
    return true
  }
}

describe('Pi HTTP MCP extension', () => {
  it('passes -e extension with credentials only in env, never on disk or argv', async () => {
    const secret = 'Bearer pi-secret-token'
    const mcpServers: McpServerConfig[] = [
      {
        id: 'tastecode',
        enabled: true,
        transport: {
          type: 'http',
          url: 'http://127.0.0.1:4555/agents/abc',
          headers: { Authorization: { source: 'credential', credentialRef: 'tc' } },
        },
      },
    ]

    let capturedArgs: string[] = []
    let capturedEnv: Record<string, string | undefined> | undefined
    const adapter = new PiAdapter({
      command: 'pi',
      spawn: ((_cmd: string, args: string[], options?: { env?: Record<string, string> }) => {
        capturedArgs = args
        capturedEnv = options?.env
        return new FakePiChild()
      }) as never,
      mcpServers,
      mcpCredentials: { tc: secret },
    })

    await adapter.startThread('/repo')
    const extIdx = capturedArgs.indexOf('-e')
    expect(extIdx).toBeGreaterThan(-1)
    expect(capturedArgs.join(' ')).not.toContain(secret)
    expect(readFileSync(capturedArgs[extIdx + 1]!, 'utf8')).not.toContain(secret)
    expect(Object.values(capturedEnv ?? {})).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:4555/agents/abc',
        JSON.stringify({ Authorization: secret }),
      ]),
    )
    await adapter.dispose()
  })

  it('registers discovered HTTP MCP tools on Pi and forwards execute calls', async () => {
    const secret = 'Bearer pi-live-secret'
    const seenMethods: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        expect(req.headers.authorization).toBe(secret)
        const parsed = JSON.parse(body) as {
          id?: number
          method: string
          params?: { name?: string; arguments?: Record<string, unknown> }
        }
        seenMethods.push(parsed.method)
        if (parsed.id === undefined) {
          res.writeHead(202).end()
          return
        }
        res.setHeader('content-type', 'application/json')
        if (parsed.method === 'initialize') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { protocolVersion: '2025-11-25' },
            }),
          )
        } else if (parsed.method === 'tools/list') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: {
                tools: [
                  {
                    name: 'list_agent_models',
                    description: 'List models',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            }),
          )
        } else if (parsed.method === 'tools/call') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { content: [{ type: 'text', text: '{"providers":["codex"]}' }] },
            }),
          )
        }
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()),
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const ext = preparePiMcpExtension(
      [
        {
          id: 'tastecode',
          enabled: true,
          transport: {
            type: 'http',
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: { Authorization: { source: 'credential', credentialRef: 'tc' } },
          },
        },
      ],
      { tc: secret },
    )!

    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(ext.env)) {
      previous.set(key, process.env[key])
      process.env[key] = value
    }
    try {
      const tools: Array<{
        name: string
        execute: (id: string, params: Record<string, unknown>) => Promise<unknown>
      }> = []
      const mod = (await import(`${pathToFileURL(ext.file).href}?t=${Date.now()}`)) as {
        default: (pi: { registerTool: (tool: (typeof tools)[number]) => void }) => Promise<void>
      }
      await mod.default({ registerTool: (tool) => tools.push(tool) })
      expect(tools.map((tool) => tool.name)).toEqual(['list_agent_models'])
      const result = await tools[0]!.execute('call-1', {})
      expect(result).toEqual({
        content: [{ type: 'text', text: '{"providers":["codex"]}' }],
        details: {},
      })
      expect(seenMethods).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
      ])
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
