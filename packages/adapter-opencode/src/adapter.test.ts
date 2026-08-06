import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { DomainEvent } from '@harness/contracts'
import type { Event } from '@opencode-ai/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenCodeAdapter, OPENCODE_CAPABILITIES, openCodeMcpConfig } from './adapter.js'

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
      instructions: 'Answer plainly.',
    })
    const completed = new Promise<void>((resolve) => {
      adapter.on('event', (event) => {
        if (event.type === 'turn.completed') resolve()
      })
    })

    await adapter.sendTurn(thread.id, 'Check the repository')
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
            inputTokens: 10,
            cachedInputTokens: 3,
            outputTokens: 5,
            reasoningTokens: 2,
            totalTokens: 17,
            costUsd: 0.01,
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
      { id: 'provider-1/model-1', displayName: 'Provider One · Model One', isDefault: true },
    ])
    expect(adapter.capabilities).toEqual(OPENCODE_CAPABILITIES)
    adapter.dispose()
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
            models: { 'model-1': { id: 'model-1', name: 'Model One' } },
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
