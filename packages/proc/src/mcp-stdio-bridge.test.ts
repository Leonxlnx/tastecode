import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpMcpBridgeLaunch } from './mcp-stdio-bridge.js'

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

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return { url: `http://127.0.0.1:${address.port}/mcp`, server }
}

describe('createHttpMcpBridgeLaunch', () => {
  it('bridges stdio JSON-RPC to HTTP with headers only in env, never on disk or argv', async () => {
    const secret = 'Bearer bridge-test-secret-token'
    const seen: Array<{ method?: string; auth?: string }> = []
    const { url } = await listen((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id?: number; method?: string }
        seen.push({ method: parsed.method, auth: req.headers.authorization })
        if (parsed.id === undefined) {
          res.writeHead(202).end()
          return
        }
        if (parsed.method === 'fail') {
          res.writeHead(500).end('boom')
          return
        }
        if (parsed.method === 'sse') {
          res
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: 'sse' } })}\n\n`,
            )
          return
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { method: parsed.method } }))
      })
    })

    const launch = createHttpMcpBridgeLaunch({ url, headers: { Authorization: secret } })
    expect(launch.args.join(' ')).not.toContain(secret)
    expect(launch.args.join(' ')).not.toContain(url)
    expect(readFileSync(launch.args[0]!, 'utf8')).not.toContain(secret)
    expect(launch.env['ELECTRON_RUN_AS_NODE']).toBe('1')

    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env },
    })
    const answers: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) answers.push(JSON.parse(line) as Record<string, unknown>)
      }
    })

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'sse' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'fail' })}\n`)

    for (let attempt = 0; attempt < 200 && answers.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    child.stdin.end()
    await new Promise<void>((resolve) => child.once('close', () => resolve()))

    expect(seen).toEqual([
      { method: 'initialize', auth: secret },
      { method: 'notifications/initialized', auth: secret },
      { method: 'sse', auth: secret },
      { method: 'fail', auth: secret },
    ])
    expect(answers).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 1, result: { method: 'initialize' } },
        { jsonrpc: '2.0', id: 2, result: { ok: 'sse' } },
        { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'HTTP 500' } },
      ]),
    )
  })
})
