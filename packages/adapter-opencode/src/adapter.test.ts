import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { DomainEvent } from '@harness/contracts'
import type { Event } from '@opencode-ai/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OpenCodeAdapter,
  OPENCODE_CAPABILITIES,
  openCodeMcpConfig,
  openCodeReasoningEfforts,
} from './adapter.js'

const CAPTURED = JSON.parse(
  readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'),
) as Event[]
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('OpenCode adapter', () => {
  it('starts and streams a captured native session through the generated SDK', async () => {
    const mock = await serveOpenCode()
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo', {
      model: 'provider-1/model-1',
      effort: 'high',
      instructions: 'Answer plainly.',
    })
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    await adapter.sendTurn(thread.id, 'Check the repository', [], {
      model: 'provider-1/model-1',
      effort: 'low',
    })
    await mock.waitFor('/session/session-1/prompt_async')
    for (const event of CAPTURED) mock.broadcast(event)
    await completed

    expect(thread).toMatchObject({ id: 'opencode-session-1', provider: 'opencode' })
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: 'Checking the repository.' }),
        expect.objectContaining({ type: 'item.delta', textDelta: 'Done.' }),
        expect.objectContaining({
          type: 'usage.updated',
          usage: {
            model: 'provider-1/model-1',
            inputTokens: 10,
            cachedInputTokens: 3,
            outputTokens: 7,
            reasoningTokens: 2,
            totalTokens: 20,
            costUsd: 0.01,
            inputIncludesCached: false,
          },
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
    expect(
      events.find((event) => event.type === 'item.started' && event.item.type === 'command'),
    ).toMatchObject({
      item: { command: 'git status --short' },
    })
    const prompt = mock.requests.find((request) => request.url.includes('prompt_async'))
    expect(prompt?.body).toMatchObject({
      model: { providerID: 'provider-1', modelID: 'model-1' },
      variant: 'low',
      system: 'Answer plainly.',
      parts: [{ type: 'text', text: 'Check the repository' }],
    })
    adapter.dispose()
  })

  it('hands the turn over through the duplicated completion idle (#373)', async () => {
    const mock = await serveOpenCode()
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const thread = await adapter.startThread('C:\\repo', { model: 'provider-1/model-1' })
    const completions: string[] = []
    adapter.on('event', (event) => {
      if (event.type === 'turn.completed') completions.push(event.turnId)
    })
    // The design flow sends the next phase prompt synchronously inside the
    // turn.completed emit; the adapter must already accept a new turn there.
    const followUp = new Promise<string>((resolve, reject) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed' && completions.length === 1) {
          adapter.sendTurn(thread.id, 'Next phase prompt').then(resolve, reject)
        }
      })
    })
    const busy = {
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'busy' } },
    } as unknown as Event
    const idle = { type: 'session.idle', properties: { sessionID: 'session-1' } } as Event

    await adapter.sendTurn(thread.id, 'First prompt')
    mock.broadcast(busy)
    // The real server emits BOTH `session.status idle` and `session.idle`
    // ~1ms apart for one completion. The duplicate lands on the fresh
    // synchronously-started turn and must not finish it as empty/successful.
    mock.broadcast(idle)
    mock.broadcast(idle)
    await expect(followUp).resolves.toContain('-turn-2')
    expect(completions).toHaveLength(1)

    mock.broadcast(busy)
    mock.broadcast(idle)
    await expect.poll(() => completions).toHaveLength(2)
    expect(completions[1]).toContain('-turn-2')
    adapter.dispose()
  })

  it('resumes, answers permissions, interrupts and lists connected models', async () => {
    const mock = await serveOpenCode()
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const thread = await adapter.resumeThread('opencode-session-1', 'C:\\repo')
    const approval = new Promise<string>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'approval.requested') resolve(event.request.id)
      })
    })
    await adapter.sendTurn(thread.id, 'Run a command')
    mock.broadcast({
      type: 'permission.updated',
      properties: {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        title: 'npm test',
        metadata: {},
        time: { created: 200 },
      },
    })
    expect(await approval).toBe('permission-1')
    adapter.respondToApproval('permission-1', 'approve-session')
    const permission = await mock.waitFor('/session/session-1/permissions/permission-1')
    expect(permission.body).toEqual({ response: 'always' })

    await adapter.interrupt(thread.id)
    expect(mock.requests.some((request) => request.url.includes('/abort'))).toBe(true)
    await expect(adapter.listModels()).resolves.toMatchObject([
      {
        id: 'provider-1/model-1',
        displayName: 'Provider One · Model One',
        isDefault: true,
        reasoningEfforts: ['default', 'low', 'high'],
        defaultReasoningEffort: 'default',
      },
    ])
    expect(adapter.capabilities).toEqual(OPENCODE_CAPABILITIES)
    adapter.dispose()
  })

  it('auto-approves permissions after setApproval flips the live mode to full', async () => {
    const mock = await serveOpenCode()
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const thread = await adapter.resumeThread('opencode-session-1', 'C:\\repo')
    const requested: string[] = []
    adapter.on('event', (event) => {
      if (event.type === 'approval.requested') requested.push(event.request.id)
    })

    adapter.setApproval('full')
    await adapter.sendTurn(thread.id, 'Run a command')
    mock.broadcast({
      type: 'permission.updated',
      properties: {
        id: 'permission-1',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'message-1',
        title: 'npm test',
        metadata: {},
        time: { created: 200 },
      },
    })
    const permission = await mock.waitFor('/session/session-1/permissions/permission-1')

    expect(permission.body).toEqual({ response: 'always' })
    expect(requested).toEqual([])
    adapter.dispose()
  })

  it('keeps a permission retryable when the reply request fails', async () => {
    const mock = await serveOpenCodeV2(1)
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const requested: string[] = []
    const resolved: string[] = []
    const logs: string[] = []
    adapter.on('event', (event) => {
      if (event.type === 'approval.requested') requested.push(event.request.id)
      if (event.type === 'approval.resolved') resolved.push(event.id)
    })
    adapter.on('log', (message) => logs.push(message))
    await adapter.resumeThread('opencode-session-v2', 'C:\\repo')

    mock.broadcast({
      type: 'permission.asked',
      data: {
        id: 'permission-retry',
        sessionID: 'session-v2',
        action: 'bash',
        resources: ['pnpm test'],
      },
    })
    await expect.poll(() => requested).toEqual(['permission-retry'])

    adapter.respondToApproval('permission-retry', 'approve')
    adapter.respondToApproval('permission-retry', 'approve')
    await expect.poll(() => logs).toContain('OpenCode permission response failed')
    expect(mock.requests.filter(isPermissionReply)).toHaveLength(1)
    adapter.respondToApproval('permission-retry', 'approve')

    await expect.poll(() => mock.requests.filter(isPermissionReply)).toHaveLength(2)
    await expect.poll(() => resolved).toEqual(['permission-retry'])
    adapter.dispose()
  })

  it.each([
    { approval: 'full' as const, action: 'bash' },
    { approval: 'auto' as const, action: 'read' },
  ])('surfaces a retry when $approval auto-reply fails', async ({ approval, action }) => {
    const mock = await serveOpenCodeV2(1)
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const requested: string[] = []
    const resolved: string[] = []
    adapter.on('event', (event) => {
      if (event.type === 'approval.requested') requested.push(event.request.id)
      if (event.type === 'approval.resolved') resolved.push(event.id)
    })
    await adapter.resumeThread('opencode-session-v2', 'C:\\repo', { approval })

    mock.broadcast({
      type: 'permission.asked',
      data: { id: 'permission-auto', sessionID: 'session-v2', action, resources: ['file.txt'] },
    })
    await expect.poll(() => requested).toEqual(['permission-auto'])
    adapter.respondToApproval('permission-auto', 'approve')

    await expect.poll(() => mock.requests.filter(isPermissionReply)).toHaveLength(2)
    await expect.poll(() => resolved).toEqual(['permission-auto'])
    adapter.dispose()
  })

  it('ignores a late reply from a disposed session with the same approval id', async () => {
    const mock = await serveOpenCodeV2(0, true)
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const requested: string[] = []
    const resolved: string[] = []
    adapter.on('event', (event) => {
      if (event.type === 'approval.requested') requested.push(event.request.id)
      if (event.type === 'approval.resolved') resolved.push(event.id)
    })
    await adapter.resumeThread('opencode-session-v2', 'C:\\repo')
    mock.broadcast(permissionAsked('permission-reused'))
    await expect.poll(() => requested).toHaveLength(1)
    adapter.respondToApproval('permission-reused', 'approve')
    await mock.waitFor('/api/session/session-v2/permission/permission-reused/reply')

    adapter.dispose()
    await adapter.resumeThread('opencode-session-v2', 'C:\\repo')
    mock.broadcast(permissionAsked('permission-reused'))
    await expect.poll(() => requested).toHaveLength(2)
    adapter.respondToApproval('permission-reused', 'approve')
    await expect.poll(() => resolved).toEqual(['permission-reused'])

    await mock.releaseHeldPermissionReply()
    await new Promise((resolve) => setImmediate(resolve))
    expect(resolved).toEqual(['permission-reused'])
    adapter.dispose()
  })

  it('reads model-specific variants from both OpenCode catalog shapes', () => {
    expect(
      openCodeReasoningEfforts({
        variants: { low: {}, high: {}, obsolete: { disabled: true } },
      }),
    ).toEqual(['default', 'low', 'high'])
    expect(
      openCodeReasoningEfforts({
        variants: [{ id: 'fast' }, { id: 'deep' }, { id: 'off', disabled: true }],
      }),
    ).toEqual(['default', 'fast', 'deep'])
  })

  it("uses each OpenCode v2 model's own variants on the wire", async () => {
    const mock = await serveOpenCodeV2()
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))

    await expect(adapter.listModels()).resolves.toMatchObject([
      {
        id: 'provider-1/model-1',
        displayName: 'Provider One · Model One',
        isDefault: true,
        reasoningEfforts: ['default', 'low', 'high'],
      },
      {
        id: 'provider-1/model-2',
        displayName: 'Provider One · Model Two',
        reasoningEfforts: ['default', 'max'],
      },
    ])

    const thread = await adapter.startThread('C:\\repo', {
      model: 'provider-1/model-1',
      effort: 'high',
      instructions: 'Answer plainly.',
    })
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })
    await adapter.sendTurn(thread.id, 'Check it', [], { effort: 'low' })
    await mock.waitFor('/api/session/session-v2/model')
    await mock.waitFor('/api/session/session-v2/prompt')
    mock.broadcast({
      type: 'session.reasoning.started',
      created: 200,
      data: { sessionID: 'session-v2', assistantMessageID: 'message-v2', ordinal: 0 },
    })
    mock.broadcast({
      type: 'session.reasoning.delta',
      data: {
        sessionID: 'session-v2',
        assistantMessageID: 'message-v2',
        ordinal: 0,
        delta: 'Checking.',
      },
    })
    mock.broadcast({
      type: 'session.reasoning.ended',
      data: {
        sessionID: 'session-v2',
        assistantMessageID: 'message-v2',
        ordinal: 0,
        text: 'Checking.',
      },
    })
    mock.broadcast({
      type: 'session.text.started',
      data: { sessionID: 'session-v2', assistantMessageID: 'message-v2', ordinal: 0 },
    })
    mock.broadcast({
      type: 'session.text.delta',
      data: {
        sessionID: 'session-v2',
        assistantMessageID: 'message-v2',
        ordinal: 0,
        delta: 'Done.',
      },
    })
    mock.broadcast({
      type: 'session.text.ended',
      data: {
        sessionID: 'session-v2',
        assistantMessageID: 'message-v2',
        ordinal: 0,
        text: 'Done.',
      },
    })
    mock.broadcast({
      type: 'session.usage.updated',
      data: {
        sessionID: 'session-v2',
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } },
        cost: 0.01,
      },
    })
    mock.broadcast({ type: 'session.execution.succeeded', data: { sessionID: 'session-v2' } })
    await completed

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'item.delta', textDelta: 'Checking.' }),
        expect.objectContaining({ type: 'item.delta', textDelta: 'Done.' }),
        expect.objectContaining({
          type: 'usage.updated',
          usage: {
            model: 'provider-1/model-1',
            inputTokens: 10,
            cachedInputTokens: 3,
            outputTokens: 7,
            reasoningTokens: 2,
            totalTokens: 20,
            costUsd: 0.01,
            inputIncludesCached: false,
          },
        }),
        expect.objectContaining({ type: 'turn.completed', status: 'completed' }),
      ]),
    )
    expect(
      mock.requests.find((request) => request.method === 'POST' && request.url.endsWith('/model'))
        ?.body,
    ).toEqual({ model: { providerID: 'provider-1', id: 'model-1', variant: 'low' } })
    expect(
      mock.requests.find((request) => request.method === 'POST' && request.url.endsWith('/prompt'))
        ?.body,
    ).toEqual({ text: 'Answer plainly.\n\nCheck it' })
    adapter.dispose()
  })

  it('rejects automatic approval review on resumed sessions too', async () => {
    await expect(
      new OpenCodeAdapter().resumeThread('opencode-session-1', 'C:\\repo', {
        approval: 'auto-review',
      }),
    ).rejects.toThrow('automatic approval review')
  })
})

type RequestRecord = { method: string; url: string; body: unknown }

async function serveOpenCode(): Promise<{
  baseUrl: string
  requests: RequestRecord[]
  broadcast(event: Event): void
  waitFor(url: string): Promise<RequestRecord>
}> {
  const requests: RequestRecord[] = []
  const streams = new Set<ServerResponse>()
  const waiters: { url: string; resolve: (request: RequestRecord) => void }[] = []
  const session = {
    id: 'session-1',
    projectID: 'project-1',
    directory: 'C:\\repo',
    title: 'Harness session',
    version: '1.18.11',
    time: { created: 100, updated: 100 },
  }
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/event')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
        'cache-control': 'no-cache',
      })
      response.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
      streams.add(response)
      request.on('close', () => streams.delete(response))
      return
    }
    const record = {
      method: request.method ?? 'GET',
      url: request.url ?? '',
      body: await requestBody(request),
    }
    requests.push(record)
    const waiter = waiters.find((entry) => record.url.startsWith(entry.url))
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(record)
    }
    if (request.url?.startsWith('/provider')) {
      return json(response, {
        all: [
          {
            id: 'provider-1',
            name: 'Provider One',
            env: [],
            models: {
              'model-1': {
                id: 'model-1',
                name: 'Model One',
                variants: { low: {}, high: {} },
              },
            },
          },
        ],
        default: { 'provider-1': 'model-1' },
        connected: ['provider-1'],
      })
    }
    if (request.method === 'GET' && request.url?.startsWith('/session/session-1'))
      return json(response, session)
    if (
      request.method === 'POST' &&
      request.url &&
      new URL(request.url, 'http://mock').pathname === '/session'
    )
      return json(response, session)
    if (request.url?.includes('/prompt_async')) {
      response.writeHead(204)
      return response.end()
    }
    return json(response, true)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    broadcast(event) {
      for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    waitFor(url) {
      const request = requests.find((entry) => entry.url.startsWith(url))
      return request
        ? Promise.resolve(request)
        : new Promise((resolve) => waiters.push({ url, resolve }))
    },
  }
}

async function serveOpenCodeV2(
  failedPermissionReplies = 0,
  holdFirstPermissionReply = false,
): Promise<{
  baseUrl: string
  requests: RequestRecord[]
  broadcast(event: unknown): void
  waitFor(url: string): Promise<RequestRecord>
  releaseHeldPermissionReply(): Promise<void>
}> {
  const requests: RequestRecord[] = []
  const streams = new Set<ServerResponse>()
  const waiters: { url: string; resolve: (request: RequestRecord) => void }[] = []
  let heldPermissionReply: ServerResponse | undefined
  const session = {
    id: 'session-v2',
    title: 'Harness v2 session',
    time: { created: 100 },
  }
  const server = createServer(async (request, response) => {
    if (request.url === '/api/event') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
        'cache-control': 'no-cache',
      })
      response.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`)
      streams.add(response)
      request.on('close', () => streams.delete(response))
      return
    }
    const record = {
      method: request.method ?? 'GET',
      url: request.url ?? '',
      body: await requestBody(request),
    }
    requests.push(record)
    const waiter = waiters.find((entry) => record.url.startsWith(entry.url))
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(record)
    }
    if (request.url === '/api/health') return json(response, { healthy: true })
    if (request.url?.startsWith('/api/provider')) {
      return json(response, { data: [{ id: 'provider-1', name: 'Provider One' }] })
    }
    if (request.url?.startsWith('/api/model')) {
      return json(response, {
        data: [
          {
            id: 'model-1',
            providerID: 'provider-1',
            name: 'Model One',
            enabled: true,
            variants: [{ id: 'low' }, { id: 'high' }],
          },
          {
            id: 'model-2',
            providerID: 'provider-1',
            name: 'Model Two',
            enabled: true,
            variants: [{ id: 'max' }],
          },
        ],
      })
    }
    if (request.url?.startsWith('/api/agent')) {
      return json(response, {
        data: [
          {
            id: 'build',
            mode: 'primary',
            model: { providerID: 'provider-1', id: 'model-1' },
          },
        ],
      })
    }
    if (request.method === 'GET' && request.url === '/api/session/session-v2') {
      return json(response, { data: session })
    }
    if (request.method === 'POST' && request.url === '/api/session') {
      return json(response, { data: session })
    }
    if (request.method === 'POST' && request.url?.endsWith('/model')) {
      response.writeHead(204)
      return response.end()
    }
    if (request.method === 'POST' && request.url?.endsWith('/prompt')) {
      return json(response, { data: { id: 'input-v2' } })
    }
    if (request.method === 'POST' && request.url?.endsWith('/interrupt')) {
      response.writeHead(204)
      return response.end()
    }
    if (request.method === 'POST' && request.url?.includes('/permission/')) {
      if (failedPermissionReplies-- > 0) {
        response.writeHead(503)
        return response.end()
      }
      if (holdFirstPermissionReply && !heldPermissionReply) {
        heldPermissionReply = response
        return
      }
      response.writeHead(204)
      return response.end()
    }
    return json(response, true)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    broadcast(event) {
      for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    waitFor(url) {
      const request = requests.find((entry) => entry.url.startsWith(url))
      return request
        ? Promise.resolve(request)
        : new Promise((resolve) => waiters.push({ url, resolve }))
    },
    async releaseHeldPermissionReply() {
      if (!heldPermissionReply) return
      const finished = once(heldPermissionReply, 'finish')
      heldPermissionReply.writeHead(204)
      heldPermissionReply.end()
      await finished
    },
  }
}

function permissionAsked(id: string): unknown {
  return {
    type: 'permission.asked',
    data: { id, sessionID: 'session-v2', action: 'bash', resources: ['pnpm test'] },
  }
}

function isPermissionReply(request: RequestRecord): boolean {
  return request.method === 'POST' && request.url.includes('/permission/')
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of request) body += chunk
  return body ? JSON.parse(body) : undefined
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

describe('openCodeMcpConfig', () => {
  it('maps stdio and http servers into opencode config, resolving credentials', () => {
    expect(
      openCodeMcpConfig(
        [
          {
            id: 'docs',
            enabled: true,
            transport: {
              type: 'stdio',
              command: 'npx',
              args: ['docs-mcp'],
              environment: {
                PLAIN: { source: 'literal', value: 'x' },
                TOKEN: { source: 'credential', credentialRef: 'ref-1' },
              },
            },
          },
          {
            id: 'remote',
            enabled: true,
            transport: {
              type: 'http',
              url: 'https://mcp.example.test',
              headers: { Authorization: { source: 'credential', credentialRef: 'ref-1' } },
            },
          },
          { id: 'off', enabled: false },
        ],
        { 'ref-1': 'secret-value' },
      ),
    ).toEqual({
      docs: {
        type: 'local',
        command: ['npx', 'docs-mcp'],
        environment: { PLAIN: 'x', TOKEN: 'secret-value' },
        enabled: true,
      },
      remote: {
        type: 'remote',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'secret-value' },
        enabled: true,
      },
      off: { type: 'local', command: ['true'], enabled: false },
    })
  })
})
