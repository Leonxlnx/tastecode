import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiAgentSession, type ApiStreamEvent } from './runtime.js'
import { jsonObject, parseJsonValue, type JsonObject, type JsonValue } from './json.js'
import { testServerBaseUrl, writeJsonResponse } from './test-server.js'
import {
  createOpenAiCompatibleTransport,
  listOpenAiCompatibleModels,
  OPENAI_COMPATIBLE_PRESETS,
} from './compatible.js'

const TEXT = readFileSync(new URL('./fixtures/compatible-text.sse', import.meta.url), 'utf8')
const TOOL = readFileSync(new URL('./fixtures/compatible-tool.sse', import.meta.url), 'utf8')
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

describe('OpenAI-compatible transport', () => {
  it('maps streamed text, reasoning and usage through one shared transport', async () => {
    const { baseUrl, requests } = await serve([TEXT])
    const events: ApiStreamEvent[] = []
    for await (const event of createOpenAiCompatibleTransport({
      apiKey: 'test-key',
      provider: 'custom',
      baseUrl,
    })({
      model: 'provider-model',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      signal: new AbortController().signal,
    }))
      events.push(event)

    expect(events).toMatchObject([
      { type: 'reasoning', delta: 'Checking.' },
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' from compatible.' },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 6,
          reasoningTokens: 1,
          totalTokens: 16,
        },
      },
      { type: 'finish', reason: 'stop' },
    ])
    expect(requests[0]).toMatchObject({
      model: 'provider-model',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(JSON.stringify(requests)).not.toContain('test-key')
  })

  it('continues a tool round with reconstructed compatible messages', async () => {
    const { baseUrl, requests } = await serve([TOOL, TEXT])
    const session = new ApiAgentSession({
      model: 'provider-model',
      transport: createOpenAiCompatibleTransport({
        apiKey: 'test-key',
        provider: 'custom',
        baseUrl,
      }),
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      executeTool: async () => ({ content: '# README' }),
    })
    const thread = session.startThread('C:\\repo', 'compatible')
    const turnId = await session.sendTurn(thread.id, 'Read the README')
    await session.waitForTurn(turnId)

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'Read the README' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '# README' },
    ])
  })

  it('drops a tool call truncated at max_tokens instead of executing it', async () => {
    // The call's JSON arguments were cut mid-stream; finish_reason is
    // 'length'. Promoting to tool_calls would execute truncated arguments.
    const truncated = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const { baseUrl } = await serve([truncated])
    const events: ApiStreamEvent[] = []
    for await (const event of createOpenAiCompatibleTransport({
      apiKey: 'test-key',
      provider: 'custom',
      baseUrl,
    })({
      model: 'provider-model',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      signal: new AbortController().signal,
    }))
      events.push(event)

    expect(events.some((event) => event.type === 'tool_call')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  })

  it('uses reviewed presets and capability-gates model discovery', async () => {
    expect(OPENAI_COMPATIBLE_PRESETS).toMatchObject({
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', modelDiscovery: true },
      kimi: { baseUrl: 'https://api.moonshot.ai/v1', modelDiscovery: true },
      zai: { baseUrl: 'https://api.z.ai/api/paas/v4', modelDiscovery: false, toolStream: true },
    })
    await expect(
      listOpenAiCompatibleModels({ apiKey: 'test-key', provider: 'zai' }),
    ).resolves.toEqual([])
  })

  it.each(['openrouter', 'kimi', 'zai'] as const)(
    'completes a streamed %s preset smoke session',
    async (provider) => {
      const { baseUrl, requests } = await serve([TEXT])
      const events: ApiStreamEvent[] = []
      for await (const event of createOpenAiCompatibleTransport({
        apiKey: 'test-key',
        provider,
        baseUrl,
      })({
        model: 'provider-model',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        signal: new AbortController().signal,
      })) {
        events.push(event)
      }

      expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
      expect(requests[0]).toMatchObject(
        provider === 'zai'
          ? { tool_stream: true, stream: true }
          : { stream_options: { include_usage: true }, stream: true },
      )
    },
  )

  it('discovers models for endpoints that expose a catalog', async () => {
    const { baseUrl } = await serve([], { data: [{ id: 'model-b' }, { id: 'model-a' }] })
    await expect(
      listOpenAiCompatibleModels({
        apiKey: 'test-key',
        provider: 'custom',
        baseUrl,
        defaultModel: 'model-b',
      }),
    ).resolves.toMatchObject([
      { id: 'model-a', isDefault: false },
      { id: 'model-b', isDefault: true },
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
    const transport = createOpenAiCompatibleTransport({
      apiKey: secret,
      provider: 'custom',
      baseUrl: testServerBaseUrl(server),
    })

    let message = ''
    try {
      for await (const _event of transport({
        model: 'test',
        messages: [],
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
    requests.push(jsonObject(parseJsonValue(await body(request))))
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
