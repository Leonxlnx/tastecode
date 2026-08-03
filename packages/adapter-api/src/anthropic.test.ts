import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnthropicMessagesTransport, listAnthropicModels } from './anthropic.js'
import { ApiAgentSession, type ApiStreamEvent } from './runtime.js'

const TEXT = readFileSync(new URL('./fixtures/anthropic-text.sse', import.meta.url), 'utf8')
const TOOL = readFileSync(new URL('./fixtures/anthropic-tool.sse', import.meta.url), 'utf8')
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

describe('Anthropic Messages transport', () => {
  it('maps captured text, usage and stop reason', async () => {
    const { baseUrl, requests } = await serve([TEXT])
    const events: ApiStreamEvent[] = []
    for await (const event of createAnthropicMessagesTransport({
      apiKey: 'test-key',
      baseUrl,
    })({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toMatchObject([
      { type: 'text', delta: 'Hello from Claude.' },
      { type: 'state', value: [{ type: 'text', text: 'Hello from Claude.' }] },
      {
        type: 'usage',
        usage: {
          inputTokens: 11,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningTokens: 0,
          totalTokens: 16,
        },
      },
      { type: 'finish', reason: 'stop' },
    ])
    expect(requests[0]).toMatchObject({
      model: 'claude-test',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    })
    expect(JSON.stringify(requests)).not.toContain('test-key')
  })

  it('continues parallel tool results in one user message', async () => {
    const { baseUrl, requests } = await serve([TOOL, TEXT])
    const session = new ApiAgentSession({
      model: 'claude-test',
      transport: createAnthropicMessagesTransport({ apiKey: 'test-key', baseUrl }),
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      executeTool: async () => ({ content: '# README' }),
    })
    const thread = session.startThread('C:\\repo', 'anthropic')
    const turnId = await session.sendTurn(thread.id, 'Read the README')
    await session.waitForTurn(turnId)

    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'Read the README' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'README.md' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '# README',
            is_error: false,
          },
        ],
      },
    ])
  })

  it('discovers every model page without a hardcoded catalog', async () => {
    const { baseUrl } = await serve([], undefined, (request, response) => {
      const second = request.url?.includes('after_id=claude-b')
      json(
        response,
        second
          ? { data: [{ id: 'claude-c', display_name: 'Claude C' }], has_more: false }
          : {
              data: [{ id: 'claude-b', display_name: 'Claude B' }],
              has_more: true,
              last_id: 'claude-b',
            },
      )
    })
    await expect(
      listAnthropicModels({ apiKey: 'test-key', baseUrl, defaultModel: 'claude-c' }),
    ).resolves.toMatchObject([
      { id: 'claude-b', displayName: 'Claude B', isDefault: false },
      { id: 'claude-c', displayName: 'Claude C', isDefault: true },
    ])
  })
})

async function serve(
  streams: string[],
  models?: unknown,
  onModels?: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = []
  let stream = 0
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/v1/models')) {
      return onModels ? onModels(request, response) : json(response, models)
    }
    requests.push(JSON.parse(await body(request)))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(streams[stream++])
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

async function body(request: IncomingMessage): Promise<string> {
  let value = ''
  for await (const chunk of request) value += chunk
  return value
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
