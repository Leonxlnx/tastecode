import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiAgentSession, type ApiStreamEvent } from './runtime.js'
import { createOpenAiResponsesTransport, listOpenAiModels } from './openai.js'
import { JsonObjectSchema, type JsonObject, type JsonValue } from './json.js'
import { testServerBaseUrl, writeJsonResponse } from './test-server.js'

const TEXT = readFileSync(new URL('./fixtures/openai-text.sse', import.meta.url), 'utf8')
const TOOL = readFileSync(new URL('./fixtures/openai-tool.sse', import.meta.url), 'utf8')
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

describe('OpenAI Responses transport', () => {
  it('maps captured text, reasoning, usage and response state', async () => {
    const { baseUrl, requests } = await serve([TEXT])
    const events: ApiStreamEvent[] = []
    for await (const event of createOpenAiResponsesTransport({ apiKey: 'test-key', baseUrl })({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toMatchObject([
      { type: 'reasoning', delta: 'Checking the request.' },
      { type: 'text', delta: 'Hello from OpenAI.' },
      { type: 'state' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          cachedInputTokens: 4,
          outputTokens: 7,
          reasoningTokens: 2,
          totalTokens: 19,
        },
      },
      { type: 'finish', reason: 'stop' },
    ])
    expect(requests[0]).toMatchObject({
      model: 'gpt-test',
      input: [{ role: 'user', content: 'Hello' }],
      stream: true,
      store: false,
    })
    expect(JSON.stringify(requests)).not.toContain('test-key')
  })

  it('continues a real tool round with the captured output items', async () => {
    const { baseUrl, requests } = await serve([TOOL, TEXT])
    const session = new ApiAgentSession({
      model: 'gpt-test',
      transport: createOpenAiResponsesTransport({ apiKey: 'test-key', baseUrl }),
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      executeTool: async () => ({ content: '# README' }),
    })
    const thread = session.startThread('C:\\repo', 'openai')
    const turnId = await session.sendTurn(thread.id, 'Read the README')
    await session.waitForTurn(turnId)

    expect(requests).toHaveLength(2)
    expect(requests[1]?.input).toEqual([
      { role: 'user', content: 'Read the README' },
      {
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '# README' },
    ])
  })

  it('discovers models without a hardcoded catalog', async () => {
    const { baseUrl } = await serve([], {
      data: [{ id: 'gpt-b' }, { id: 'gpt-a' }],
    })
    await expect(
      listOpenAiModels({ apiKey: 'test-key', baseUrl, defaultModel: 'gpt-b' }),
    ).resolves.toMatchObject([
      { id: 'gpt-a', isDefault: false },
      { id: 'gpt-b', isDefault: true },
    ])
  })

  it('keeps provider error bodies and credentials private', async () => {
    const secret = 'sk-provider-secret'
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `rejected ${secret}` }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const transport = createOpenAiResponsesTransport({
      apiKey: secret,
      baseUrl: testServerBaseUrl(server),
    })

    let message = ''
    try {
      for await (const _event of transport({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        signal: new AbortController().signal,
      })) {
        // The request fails before any event can be emitted.
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('request failed with HTTP 401')
    expect(message).toContain('rejected')
    expect(message).not.toContain(secret)
  })
})

async function serve(
  streams: string[],
  models: JsonValue = { data: [] },
): Promise<{ baseUrl: string; requests: JsonObject[] }> {
  const requests: JsonObject[] = []
  let stream = 0
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') return writeJsonResponse(response, models)
    requests.push(JsonObjectSchema.parse(JSON.parse(await body(request))))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(streams[stream++])
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: testServerBaseUrl(server), requests }
}

async function body(request: IncomingMessage): Promise<string> {
  let value = ''
  for await (const chunk of request) value += chunk
  return value
}
