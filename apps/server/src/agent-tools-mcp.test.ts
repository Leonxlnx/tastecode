import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentToolError,
  AgentToolsEndpoint,
  type AgentToolsBroker,
  type AgentToolsCaller,
} from './agent-tools-mcp.js'

function fakeBroker(overrides: Partial<AgentToolsBroker> = {}): AgentToolsBroker {
  return {
    listModels: vi.fn(async () => ({ providers: [{ provider: 'codex', models: ['gpt-5.5'] }] })),
    start: vi.fn(async (_caller: AgentToolsCaller, args) => ({
      agent_id: 'a1',
      status: 'running',
      provider: args.provider,
    })),
    wait: vi.fn(async () => ({ agents: [] })),
    stop: vi.fn(async () => ({ agent_id: 'a1', status: 'stopped' })),
    ...overrides,
  }
}

type Reply = { status: number; body: string }

function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
  signal?: AbortSignal,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method, headers: { 'content-type': 'application/json', ...headers }, signal },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

const endpoints: AgentToolsEndpoint[] = []
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()))
})

async function open(broker = fakeBroker()) {
  const endpoint = new AgentToolsEndpoint(broker)
  endpoints.push(endpoint)
  const url = await endpoint.url()
  const grant = endpoint.grant()
  grant.bind('claude-code-parent')
  const rpc = async (method: string, params?: unknown, id: number | null = 1) => {
    const reply = await post(
      url,
      JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
      { authorization: grant.authorization },
    )
    return { ...reply, json: reply.body ? JSON.parse(reply.body) : undefined }
  }
  return { endpoint, url, grant, rpc, broker }
}

describe('agent tools MCP endpoint', () => {
  it('listens on 127.0.0.1 under a random path', async () => {
    const { url } = await open()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agents\/[0-9a-f]{32}$/)
  })

  it('negotiates a protocol version it knows and falls back to its newest', async () => {
    const { rpc } = await open()
    for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
      const { json } = await rpc('initialize', { protocolVersion: version, capabilities: {} })
      expect(json.result.protocolVersion).toBe(version)
      expect(json.result.capabilities).toEqual({ tools: { listChanged: false } })
    }
    const { json } = await rpc('initialize', { protocolVersion: '2099-01-01' })
    expect(json.result.protocolVersion).toBe('2025-06-18')
  })

  it('answers ping and lists the four tools as JSON', async () => {
    const { rpc } = await open()
    expect((await rpc('ping')).json).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    const listed = await rpc('tools/list')
    expect(listed.status).toBe(200)
    expect(listed.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_agent_models',
      'start_agent',
      'wait_for_agents',
      'stop_agent',
    ])
  })

  it('routes tool calls to the broker with the calling chat', async () => {
    const { rpc, broker } = await open()
    const started = await rpc('tools/call', {
      name: 'start_agent',
      arguments: { provider: 'codex', model: 'gpt-5.5', task: 'Write the tests' },
    })
    expect(JSON.parse(started.json.result.content[0].text)).toEqual({
      agent_id: 'a1',
      status: 'running',
      provider: 'codex',
    })
    expect(broker.start).toHaveBeenCalledWith(
      { threadId: 'claude-code-parent' },
      { provider: 'codex', model: 'gpt-5.5', task: 'Write the tests' },
    )
    await rpc('tools/call', { name: 'wait_for_agents', arguments: {} })
    expect(broker.wait).toHaveBeenCalledWith(
      { threadId: 'claude-code-parent' },
      { return_when: 'all', timeout_seconds: 30 },
      expect.any(AbortSignal),
    )
    await rpc('tools/call', { name: 'stop_agent', arguments: { agent_id: 'a1' } })
    expect(broker.stop).toHaveBeenCalledWith({ threadId: 'claude-code-parent' }, { agent_id: 'a1' })
    await rpc('tools/call', { name: 'list_agent_models' })
    expect(broker.listModels).toHaveBeenCalledWith({ threadId: 'claude-code-parent' })
  })

  it('reports bad arguments, refusals and unknown tools as tool errors the agent can read', async () => {
    const { rpc } = await open(
      fakeBroker({
        start: async () => {
          throw new AgentToolError('This chat already runs 4 sub-agents.')
        },
        stop: async () => {
          throw new Error('C:\\Users\\someone\\secret path')
        },
      }),
    )
    const invalid = await rpc('tools/call', {
      name: 'wait_for_agents',
      arguments: { timeout_seconds: 120 },
    })
    expect(invalid.json.result.isError).toBe(true)
    expect(invalid.json.result.content[0].text).toMatch(/timeout_seconds/)
    const refused = await rpc('tools/call', {
      name: 'start_agent',
      arguments: { provider: 'codex', task: 'x' },
    })
    expect(refused.json.result).toEqual({
      content: [{ type: 'text', text: 'This chat already runs 4 sub-agents.' }],
      isError: true,
    })
    const failed = await rpc('tools/call', { name: 'stop_agent', arguments: { agent_id: 'a1' } })
    expect(failed.json.result.isError).toBe(true)
    expect(failed.json.result.content[0].text).not.toMatch(/secret/)
    const unknown = await rpc('tools/call', { name: 'delete_everything' })
    expect(unknown.json.result.isError).toBe(true)
  })

  it('accepts notifications with 202 and refuses unknown methods', async () => {
    const { rpc } = await open()
    const notified = await rpc('notifications/initialized', undefined, null)
    expect(notified.status).toBe(202)
    expect(notified.body).toBe('')
    expect((await rpc('resources/list')).json.error.code).toBe(-32601)
  })

  it('answers a batch in order', async () => {
    const { url, grant } = await open()
    const reply = await post(
      url,
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]),
      { authorization: grant.authorization },
    )
    const answers = JSON.parse(reply.body)
    expect(answers.map((answer: { id: number }) => answer.id)).toEqual([1, 2])
  })

  it('refuses a missing or wrong token, a revoked grant, any Origin, other methods and big bodies', async () => {
    const { url, grant, endpoint } = await open()
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    expect((await post(url, ping)).status).toBe(401)
    expect((await post(url, ping, { authorization: `Bearer ${'x'.repeat(43)}` })).status).toBe(401)
    expect((await post(url, ping, { authorization: grant.authorization.slice(7) })).status).toBe(
      401,
    )
    expect(
      (await post(url, ping, { authorization: grant.authorization, origin: 'http://127.0.0.1' }))
        .status,
    ).toBe(403)
    expect((await post(url, '', { authorization: grant.authorization }, 'GET')).status).toBe(405)
    expect((await post(`${url}x`, ping, { authorization: grant.authorization })).status).toBe(404)
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(300_000) })
    expect((await post(url, big, { authorization: grant.authorization })).status).toBe(413)
    const malformed = await post(url, '{', { authorization: grant.authorization })
    expect(JSON.parse(malformed.body).error.code).toBe(-32700)

    const other = endpoint.grant()
    other.revoke()
    expect((await post(url, ping, { authorization: other.authorization })).status).toBe(401)
  })

  it('tells a chat that has not started yet to try again', async () => {
    const broker = fakeBroker()
    const { url, endpoint } = await open(broker)
    const early = endpoint.grant()
    const reply = await post(
      url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_agent_models' },
      }),
      { authorization: early.authorization },
    )
    expect(JSON.parse(reply.body).result.isError).toBe(true)
    expect(broker.listModels).not.toHaveBeenCalled()
  })

  it('aborts a wait when the caller hangs up, and frees its port on close', async () => {
    let waitSignal: AbortSignal | undefined
    const broker = fakeBroker({
      wait: (_caller, _args, signal) => {
        waitSignal = signal
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({})))
      },
    })
    const { url, grant, endpoint } = await open(broker)
    const hangUp = new AbortController()
    const pending = post(
      url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait_for_agents', arguments: { timeout_seconds: 50 } },
      }),
      { authorization: grant.authorization },
      'POST',
      hangUp.signal,
    ).catch((error: unknown) => error)
    await vi.waitFor(() => expect(waitSignal).toBeDefined())
    hangUp.abort()
    await pending
    await vi.waitFor(() => expect(waitSignal?.aborted).toBe(true))

    await endpoint.close()
    await expect(post(url, '{}', { authorization: grant.authorization })).rejects.toThrow()
    await expect(endpoint.url()).rejects.toThrow(/closed/)
  })
})
