import { EventEmitter, once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { DomainEvent } from '@harness/contracts'
import {
  JsonRpcValueSchema,
  MAX_PROTOCOL_FRAME_BYTES,
  type JsonRpcValue,
  type spawnCli,
} from '@harness/proc'
import type { Event } from '@opencode-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  OpenCodeAdapter,
  OPENCODE_CAPABILITIES,
  OPENCODE_SERVER_START_TIMEOUT_MS,
  openCodeMcpConfig,
  openCodeReasoningEfforts,
} from './adapter.js'
import type { OpenCodeV2Event, OpenCodeWireEvent } from './events.js'

// SAFETY: This immutable fixture is a direct capture of the SDK event stream and
// every entry is exercised by the mapper before its fields are used in assertions.
const CAPTURED = JSON.parse(
  readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'),
) as Event[]

// SAFETY: Frames captured from opencode 1.18.31's v1 /event stream against a
// scripted model (session id normalised to the mock's): a plain answer, a bash
// call that asks permission, and a provider error.
const CAPTURED_1_18_31 = JSON.parse(
  readFileSync(new URL('./fixtures/opencode-1.18.31-v1-turns.json', import.meta.url), 'utf8'),
) as Record<'text' | 'tool' | 'failure', OpenCodeWireEvent[]>

function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

function fixture(name: string): JsonRpcValue {
  return JsonRpcValueSchema.parse(JSON.parse(fixtureText(name)))
}

/**
 * Captured from `opencode serve` 1.18.13 with one stored credential (MiniMax
 * Token Plan) plus OpenCode's free tier, trimmed to the fields the adapter
 * reads: `GET /config/providers`, the warm v2 `GET /api/model` (with its
 * deprecated rows) and `GET /api/agent`, and the ids `opencode models` printed.
 */
const OPENCODE_CONFIG_PROVIDERS = fixture('opencode-1.18.13-config-providers.json')
const OPENCODE_API_MODEL = fixture('opencode-1.18.13-api-model.json')
const OPENCODE_API_AGENT = fixture('opencode-1.18.13-api-agent.json')
const OPENCODE_MODELS = fixtureText('opencode-1.18.13-models.txt').split(/\r?\n/).filter(Boolean)
const CONFIG_PROVIDERS = z
  .object({
    providers: z.array(
      z.object({
        id: z.string(),
        models: z.record(z.string(), z.object({ id: z.string(), release_date: z.string() })),
      }),
    ),
  })
  .parse(OPENCODE_CONFIG_PROVIDERS)
const API_MODEL_ROWS = z.object({ data: z.array(JsonRpcValueSchema) }).parse(OPENCODE_API_MODEL)
const API_MODELS = z
  .object({
    data: z.array(z.object({ id: z.string(), providerID: z.string(), status: z.string() })),
  })
  .parse(OPENCODE_API_MODEL)
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('OpenCode adapter', () => {
  it('does not reuse a turn identity when a fresh instance resumes', async () => {
    const mock = await serveOpenCodeV2()
    const first = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const resumed = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    try {
      const thread = await first.startThread('/repo')
      const previous = await first.sendTurn(thread.id, 'One')
      first.dispose()
      await resumed.resumeThread(thread.id, '/repo')
      expect(await resumed.sendTurn(thread.id, 'Two')).not.toBe(previous)
    } finally {
      first.dispose()
      resumed.dispose()
    }
  })

  it.each(['v1', 'v2'] as const)(
    'fails the active turn when a %s SSE event exceeds the bound',
    async (protocol) => {
      const mock = protocol === 'v1' ? await serveOpenCode() : await serveOpenCodeV2()
      const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      try {
        const thread = await adapter.startThread('/repo')
        const events: DomainEvent[] = []
        adapter.on('event', (event) => events.push(event))
        await adapter.sendTurn(thread.id, 'Work')
        const oversize = 'x'.repeat(MAX_PROTOCOL_FRAME_BYTES)
        if (protocol === 'v1') {
          // SAFETY: Unknown vendor events are valid SSE JSON and the framing
          // limit must reject them before any domain payload is interpreted.
          mock.broadcast({ type: 'oversized', properties: { value: oversize } } as never)
        } else {
          mock.broadcast({ type: 'oversized', data: { value: oversize } } as never)
        }
        await expect
          .poll(() =>
            events.some((event) => event.type === 'turn.completed' && event.status === 'failed'),
          )
          .toBe(true)
        await expect(adapter.sendTurn(thread.id, 'Retry')).rejects.toThrow()
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each(['v1', 'v2'] as const)(
    'reports %s stream EOF after the terminal event so the owner can resume the next turn',
    async (protocol) => {
      const mock = protocol === 'v1' ? await serveOpenCode() : await serveOpenCodeV2()
      const first = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const resumed = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const events: DomainEvent[] = []
      first.on('event', (event) => events.push(event))
      const disconnected = vi.fn(() => events.slice())
      const unsubscribe = first.onDisconnected(disconnected)
      try {
        const thread = await first.startThread('C:\\repo')
        const failedTurn = await first.sendTurn(thread.id, 'First turn')
        mock.endStreams()
        await expect.poll(() => disconnected.mock.calls.length).toBe(1)
        expect(disconnected.mock.results[0]!.value).toEqual(events)
        expect(events.at(-1)).toEqual({
          type: 'turn.completed',
          turnId: failedTurn,
          status: 'failed',
        })
        await expect(first.sendTurn(thread.id, 'Next turn')).rejects.toThrow(
          'OpenCode event stream disconnected',
        )

        // The owner drops this runtime on disconnect and resumes its saved session.
        await first.dispose()
        await resumed.resumeThread(thread.id, 'C:\\repo')
        const nextTurn = await resumed.sendTurn(thread.id, 'Next turn')
        expect(nextTurn).not.toBe(failedTurn)
        await expect
          .poll(() =>
            mock.requests.filter((request) => /\/prompt(?:_async)?(?:\?|$)/.test(request.url)),
          )
          .toHaveLength(2)
        expect(disconnected).toHaveBeenCalledOnce()
        unsubscribe()
        expect(first.listenerCount('disconnected')).toBe(0)
      } finally {
        unsubscribe()
        await first.dispose()
        await resumed.dispose()
      }
    },
  )

  it.each(['v1', 'v2'] as const)(
    'does not report deliberate %s stream replacement or disposal as disconnect',
    async (protocol) => {
      const mock = protocol === 'v1' ? await serveOpenCode() : await serveOpenCodeV2()
      const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const disconnected = vi.fn()
      adapter.onDisconnected(disconnected)
      try {
        const thread = await adapter.startThread('C:\\repo')
        await adapter.resumeThread(thread.id, 'C:\\repo')
        await adapter.dispose()
        await new Promise((resolve) => setImmediate(resolve))
        expect(disconnected).not.toHaveBeenCalled()
      } finally {
        await adapter.dispose()
      }
    },
  )

  it.each(['start', 'resume'] as const)(
    'rejects v1 %s when its event stream ends while the session response is pending',
    async (operation) => {
      let releaseSession!: () => void
      const sessionResponse = new Promise<void>((resolve) => {
        releaseSession = resolve
      })
      const mock = await serveOpenCode(() => sessionResponse)
      const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const logs: string[] = []
      adapter.on('log', (line) => logs.push(line))
      try {
        const opening =
          operation === 'start'
            ? adapter.startThread('C:\\repo')
            : adapter.resumeThread('opencode-session-1', 'C:\\repo')
        const result = opening.then(
          () => undefined,
          (error: unknown) => error,
        )
        // The session request itself, not the protocol probe of /session/status.
        if (operation === 'start') {
          await expect
            .poll(() =>
              mock.requests.some(
                (request) =>
                  request.method === 'POST' &&
                  new URL(request.url, 'http://mock').pathname === '/session',
              ),
            )
            .toBe(true)
        } else await mock.waitFor('/session/session-1')
        mock.endStreams()
        await expect.poll(() => logs).toContain('OpenCode event stream disconnected')
        releaseSession()
        await expect(result).resolves.toEqual(new Error('OpenCode event stream disconnected'))
      } finally {
        releaseSession()
        await adapter.dispose()
      }
    },
  )

  it.each(['v1', 'v2'] as const)(
    'replays a %s disconnect that happens before the owner attaches its listener',
    async (protocol) => {
      const mock = protocol === 'v1' ? await serveOpenCode() : await serveOpenCodeV2()
      const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const logs: string[] = []
      adapter.on('log', (line) => logs.push(line))
      try {
        const thread = await adapter.startThread('C:\\repo')
        mock.endStreams()
        await expect.poll(() => logs).toContain('OpenCode event stream disconnected')
        const disconnected = vi.fn()
        const unsubscribe = adapter.onDisconnected(disconnected)
        expect(disconnected).toHaveBeenCalledOnce()
        await new Promise((resolve) => setImmediate(resolve))
        expect(disconnected).toHaveBeenCalledOnce()
        unsubscribe()

        await adapter.dispose()
        const nextDisconnected = vi.fn()
        adapter.onDisconnected(nextDisconnected)
        expect(nextDisconnected).not.toHaveBeenCalled()
        await adapter.resumeThread(thread.id, 'C:\\repo')
        expect(nextDisconnected).not.toHaveBeenCalled()
        mock.endStreams()
        await expect.poll(() => nextDisconnected.mock.calls.length).toBe(1)
        expect(disconnected).toHaveBeenCalledOnce()
      } finally {
        await adapter.dispose()
      }
    },
  )

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

  it('rejects a model without a provider before the turn opens', async () => {
    const mock = await serveOpenCode()
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    const thread = await adapter.startThread('C:\\repo', { model: 'provider-1/model-1' })

    await expect(adapter.sendTurn(thread.id, 'Go', [], { model: 'gpt-5' })).rejects.toThrow(
      'OpenCode models use provider/model',
    )
    expect(events.some((event) => event.type === 'turn.started')).toBe(false)

    await adapter.sendTurn(thread.id, 'Go again', [], { model: 'provider-1/model-1' })
    const prompt = await mock.waitFor('/session/session-1/prompt_async')
    expect(prompt.body).toMatchObject({ model: { providerID: 'provider-1', modelID: 'model-1' } })
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
    } satisfies OpenCodeWireEvent
    const idle = {
      type: 'session.idle',
      properties: { sessionID: 'session-1' },
    } satisfies OpenCodeWireEvent

    await adapter.sendTurn(thread.id, 'First prompt')
    mock.broadcast(busy)
    // The real server emits BOTH `session.status idle` and `session.idle`
    // ~1ms apart for one completion. The duplicate lands on the fresh
    // synchronously-started turn and must not finish it as empty/successful.
    mock.broadcast(idle)
    mock.broadcast(idle)
    expect(await followUp).not.toBe(completions[0])
    expect(completions).toHaveLength(1)

    mock.broadcast(busy)
    mock.broadcast(idle)
    await expect.poll(() => completions).toHaveLength(2)
    expect(completions[1]).not.toBe(completions[0])
    adapter.dispose()
  })

  describe('opencode 1.18.31', () => {
    async function capturedTurn(approval: 'ask' | 'full' = 'ask') {
      const mock = await serveOpenCode()
      const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const events: DomainEvent[] = []
      adapter.on('event', (event) => events.push(event))
      const thread = await adapter.startThread('/repo', { approval })
      const completed = new Promise<DomainEvent>((resolve) => {
        adapter.on('event', (event) => {
          if (event.type === 'turn.completed') resolve(event)
        })
      })
      return { mock, adapter, events, thread, completed }
    }

    it("reads a model's context size once, as OpenCode lists it", async () => {
      const { mock, adapter } = await capturedTurn()
      try {
        await expect(adapter.modelContextWindow('provider-1/model-1')).resolves.toBe(32_000)
        await expect(adapter.modelContextWindow('provider-1/model-1')).resolves.toBe(32_000)
        await expect(adapter.modelContextWindow('provider-1/unknown')).resolves.toBeUndefined()
        await expect(adapter.modelContextWindow('no-provider')).resolves.toBeUndefined()
        await expect(adapter.modelContextWindow(undefined)).resolves.toBeUndefined()
        expect(
          mock.requests.filter((request) => request.url.startsWith('/config/providers')),
        ).toHaveLength(2)
      } finally {
        await adapter.dispose()
      }
    })

    it('speaks v1 to a server that also answers v2', async () => {
      const { mock, adapter } = await capturedTurn()
      try {
        expect(
          mock.requests.some(
            (request) =>
              request.method === 'POST' &&
              new URL(request.url, 'http://mock').pathname === '/session',
          ),
        ).toBe(true)
        expect(mock.requests.some((request) => request.url.startsWith('/api/session'))).toBe(false)
      } finally {
        await adapter.dispose()
      }
    })

    it('streams the answer of a captured turn without echoing the prompt as one', async () => {
      const { mock, adapter, events, thread, completed } = await capturedTurn()
      try {
        await adapter.sendTurn(thread.id, 'Reply with only OK')
        await mock.waitFor('/session/session-1/prompt_async')
        for (const event of CAPTURED_1_18_31.text) mock.broadcast(event)

        expect(await completed).toMatchObject({ status: 'completed' })
        const messages = events.flatMap((event) =>
          event.type === 'item.completed' && event.item.type === 'message' ? [event.item] : [],
        )
        expect(messages.map((item) => [item.role, item.text])).toEqual([['assistant', 'OK']])
        // The answer streamed as it arrived, not only once it was complete.
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'item.delta', textDelta: 'OK' }),
        )
      } finally {
        await adapter.dispose()
      }
    })

    it('asks a captured permission and resolves it once', async () => {
      const { mock, adapter, events, thread, completed } = await capturedTurn('ask')
      try {
        await adapter.sendTurn(thread.id, 'RUN_TOOL please')
        await mock.waitFor('/session/session-1/prompt_async')
        const frames = CAPTURED_1_18_31.tool
        const asked = frames.findIndex((event) => event.type === 'permission.asked')
        for (const event of frames.slice(0, asked + 1)) mock.broadcast(event)
        const request = await vi.waitFor(() => {
          const found = events.find((event) => event.type === 'approval.requested')
          if (!found || found.type !== 'approval.requested') throw new Error('not asked yet')
          return found.request
        })
        expect(request).toMatchObject({ kind: 'command', command: 'echo stub-ran' })

        adapter.respondToApproval(request.id, 'approve')
        const reply = await mock.waitFor(`/session/session-1/permissions/${request.id}`)
        expect(reply.body).toEqual({ response: 'once' })
        for (const event of frames.slice(asked + 1)) mock.broadcast(event)

        expect(await completed).toMatchObject({ status: 'completed' })
        expect(events.filter((event) => event.type === 'approval.resolved')).toHaveLength(1)
        expect(
          events.find((event) => event.type === 'item.completed' && event.item.type === 'command'),
        ).toMatchObject({ item: { command: 'echo stub-ran', status: 'completed' } })
        expect(
          events.flatMap((event) =>
            event.type === 'item.completed' && event.item.type === 'message'
              ? [event.item.text]
              : [],
          ),
        ).toEqual(['The command printed stub-ran.'])
      } finally {
        await adapter.dispose()
      }
    })

    it("names the provider's reason when a captured turn fails", async () => {
      const { mock, adapter, events, thread, completed } = await capturedTurn()
      try {
        await adapter.sendTurn(thread.id, 'FAIL please')
        await mock.waitFor('/session/session-1/prompt_async')
        for (const event of CAPTURED_1_18_31.failure) mock.broadcast(event)

        expect(await completed).toMatchObject({ status: 'failed' })
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'thread.error',
            message: 'The OpenCode request failed: stub refused the request',
          }),
        )
      } finally {
        await adapter.dispose()
      }
    })

    it('ends a turn stopped from another OpenCode client as interrupted', async () => {
      const { mock, adapter, events, thread, completed } = await capturedTurn()
      try {
        await adapter.sendTurn(thread.id, 'SLOW please')
        await mock.waitFor('/session/session-1/prompt_async')
        // The prompt's own frames first, so the turn has seen session activity.
        for (const event of CAPTURED_1_18_31.text.slice(0, 3)) mock.broadcast(event)
        mock.broadcast({
          type: 'session.error',
          properties: {
            sessionID: 'session-1',
            error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
          },
        } as OpenCodeWireEvent)

        expect(await completed).toMatchObject({ status: 'interrupted' })
        expect(events.some((event) => event.type === 'thread.error')).toBe(false)
      } finally {
        await adapter.dispose()
      }
    })
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
        displayName: 'Model One',
        isDefault: true,
        reasoningEfforts: ['default', 'low', 'high'],
        defaultReasoningEffort: 'default',
      },
    ])
    expect(adapter.capabilities).toEqual(OPENCODE_CAPABILITIES)
    adapter.dispose()
  })

  it.each(['v1', 'v2'] as const)(
    'keeps %s Full auto-approvals one-shot so narrowing to Ask takes effect',
    async (protocol) => {
      const mock = protocol === 'v1' ? await serveOpenCode() : await serveOpenCodeV2()
      const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
      const session = protocol === 'v1' ? 'session-1' : 'session-v2'
      const replyBody = (response: string) =>
        protocol === 'v1' ? { response } : { reply: response }
      const replyPath = (id: string) =>
        protocol === 'v1'
          ? `/session/${session}/permissions/${id}`
          : `/api/session/${session}/permission/${id}/reply`
      const requestPermission = (id: string) => {
        if ('releaseHeldPermissionReply' in mock) {
          mock.broadcast(permissionAsked(id))
        } else {
          mock.broadcast({
            type: 'permission.updated',
            properties: {
              id,
              type: 'bash',
              sessionID: session,
              messageID: 'message-1',
              title: 'pnpm test',
              metadata: {},
              time: { created: 200 },
            },
          })
        }
      }
      const requested: string[] = []
      const resolved: string[] = []
      adapter.on('event', (event) => {
        if (event.type === 'approval.requested') requested.push(event.request.id)
        if (event.type === 'approval.resolved') resolved.push(event.id)
      })
      try {
        const thread = await adapter.resumeThread(`opencode-${session}`, 'C:\\repo')
        adapter.setApproval('full')
        await adapter.sendTurn(thread.id, 'Run a command')
        requestPermission('permission-full')
        expect((await mock.waitFor(replyPath('permission-full'))).body).toEqual(replyBody('once'))
        await expect.poll(() => resolved).toEqual(['permission-full'])
        expect(requested).toEqual([])

        adapter.setApproval('ask')
        requestPermission('permission-ask')
        await expect.poll(() => requested).toEqual(['permission-ask'])
        expect(mock.requests.some((request) => request.url === replyPath('permission-ask'))).toBe(
          false,
        )
        adapter.respondToApproval('permission-ask', 'approve')
        expect((await mock.waitFor(replyPath('permission-ask'))).body).toEqual(replyBody('once'))

        requestPermission('permission-explicit-session')
        await expect
          .poll(() => requested)
          .toEqual(['permission-ask', 'permission-explicit-session'])
        adapter.respondToApproval('permission-explicit-session', 'approve-session')
        expect((await mock.waitFor(replyPath('permission-explicit-session'))).body).toEqual(
          replyBody('always'),
        )
      } finally {
        await adapter.dispose()
      }
    },
  )

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
        displayName: 'Model One',
        isDefault: true,
        reasoningEfforts: ['default', 'low', 'high'],
      },
      {
        id: 'provider-1/model-2',
        displayName: 'Model Two',
        // v2 sessions start on the build agent's model, not a provider's pick.
        isDefault: false,
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

  it('offers only the models of providers OpenCode reports as connected', async () => {
    // The warm v2 catalog with its deprecated rows, plus a models.dev row of a
    // provider without a credential, as a cold v2 catalog lists them.
    const catalog = {
      data: [
        ...API_MODEL_ROWS.data,
        { id: 'deepseek-v4-pro', providerID: 'deepseek', name: 'DeepSeek V4 Pro', variants: [] },
      ],
    }
    const mock = await serveCatalog({
      '/config/providers': OPENCODE_CONFIG_PROVIDERS,
      '/api/model': catalog,
      '/api/agent': OPENCODE_API_AGENT,
      '/api/provider': { data: [{ id: 'opencode' }, { id: 'deepseek' }] },
    })
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    try {
      const models = await adapter.listModels()
      const ids = models.map((model) => model.id)
      expect([...ids].sort()).toEqual([...OPENCODE_MODELS].sort())
      expect(ids.some((id) => id.startsWith('deepseek/'))).toBe(false)
      const deprecated = API_MODELS.data
        .filter((model) => model.status === 'deprecated')
        .map((model) => `${model.providerID}/${model.id}`)
      expect(deprecated.length).toBeGreaterThan(0)
      expect(ids.filter((id) => deprecated.includes(id))).toEqual([])
      const released = new Map(
        CONFIG_PROVIDERS.providers.flatMap((provider) =>
          Object.values(provider.models).map((model) => [
            `${provider.id}/${model.id}`,
            model.release_date,
          ]),
        ),
      )
      const days = ids.map((id) => released.get(id) ?? '')
      expect(days).toEqual([...days].sort().reverse())
      expect(ids[0]).toBe('opencode/nemotron-3.5-super-vl-free')
      expect(
        models
          .filter((model) => model.recommended)
          .map((model) => model.id)
          .sort(),
      ).toEqual(
        [
          'minimax-coding-plan/MiniMax-M3',
          'opencode/deepseek-v4.1-flash-free',
          'opencode/glm-5.3-flash-free',
          'opencode/mimo-v2.6-flash-free',
        ].sort(),
      )
      // No agent names a model and the v2 catalog lists no variants.
      expect(models.filter((model) => model.isDefault)).toEqual([])
      expect(models.filter((model) => model.reasoningEfforts.length > 0)).toEqual([])
      expect(mock.urls.some((url) => url.startsWith('/api/provider'))).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  it("hands OpenCode's model status to the lineage", async () => {
    const mock = await serveCatalog({
      '/config/providers': {
        providers: [
          {
            id: 'tinfoil',
            name: 'Tinfoil',
            models: {
              'deepseek-v4-1-flash': {
                id: 'deepseek-v4-1-flash',
                name: 'DeepSeek V4.1 Flash',
                status: 'beta',
                release_date: '2026-09-10',
              },
              'deepseek-v4-flash': {
                id: 'deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                status: 'active',
                release_date: '2026-04-24',
              },
            },
          },
        ],
        default: {},
      },
      '/api/model': { data: [] },
      '/api/agent': { data: [] },
    })
    const adapter = new OpenCodeAdapter({ baseUrl: mock.baseUrl })
    try {
      expect(
        (await adapter.listModels()).map((model) => [model.id, model.family, model.generation]),
      ).toEqual([
        ['tinfoil/deepseek-v4-1-flash', 'tinfoil/deepseek v# flash beta', '4.1'],
        ['tinfoil/deepseek-v4-flash', 'tinfoil/deepseek v# flash', '4'],
      ])
    } finally {
      await adapter.dispose()
    }
  })

  it('rejects automatic approval review on resumed sessions too', async () => {
    await expect(
      new OpenCodeAdapter().resumeThread('opencode-session-1', 'C:\\repo', {
        approval: 'auto-review',
      }),
    ).rejects.toThrow('automatic approval review')
  })

  it('shares one server launch between concurrent starts', async () => {
    const mock = await serveOpenCodeV2()
    const serve = fakeOpenCodeServe()
    const adapter = new OpenCodeAdapter({ spawn: serve.spawn })
    try {
      const starts = Promise.all([adapter.start(), adapter.listModels()])
      expect(serve.children).toHaveLength(1)
      serve.children[0]!.stdout.write(`opencode server listening on ${mock.baseUrl}\n`)
      await starts
      await adapter.start()
      expect(serve.children).toHaveLength(1)
    } finally {
      await adapter.dispose()
    }
  })

  it('starts a serve that needs 10 s to print its URL', async () => {
    const mock = await serveOpenCodeV2()
    const serve = fakeOpenCodeServe()
    const adapter = new OpenCodeAdapter({ spawn: serve.spawn })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const starting = adapter.start()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(serve.children[0]!.kill).not.toHaveBeenCalled()
      serve.children[0]!.stdout.write(`opencode server listening on ${mock.baseUrl}\n`)
      vi.useRealTimers()
      await starting
      expect(serve.children[0]!.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      await adapter.dispose()
    }
  })

  it('stops a serve that never prints its URL before it reports OpenCode unavailable', async () => {
    const serve = fakeOpenCodeServe()
    const adapter = new OpenCodeAdapter({ spawn: serve.spawn })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const failed = expect(adapter.start()).rejects.toThrow('OpenCode is unavailable')
      await vi.advanceTimersByTimeAsync(OPENCODE_SERVER_START_TIMEOUT_MS - 1)
      expect(serve.children[0]!.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await failed
      expect(serve.children[0]!.kill).toHaveBeenCalled()
      expect(serve.children).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await adapter.dispose()
    }
  })

  it('stops a server that finishes launching after dispose', async () => {
    const serve = fakeOpenCodeServe()
    const adapter = new OpenCodeAdapter({ spawn: serve.spawn })
    const starting = adapter.start()
    await adapter.dispose()
    serve.children[0]!.stdout.write('opencode server listening on http://127.0.0.1:9\n')

    await expect(starting).rejects.toThrow('stopped while it was starting')
    expect(serve.children[0]!.kill).toHaveBeenCalled()
  })

  it('stops a serve that is still starting as soon as it is disposed', async () => {
    const serve = fakeOpenCodeServe()
    const adapter = new OpenCodeAdapter({ spawn: serve.spawn })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stopped = expect(adapter.start()).rejects.toThrow('stopped while it was starting')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(serve.children[0]!.kill).not.toHaveBeenCalled()
      // Disposal waits for the serve, without the 30 s start limit.
      await adapter.dispose()
      expect(serve.children[0]!.kill).toHaveBeenCalled()
      await stopped
      expect(serve.children).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

function fakeOpenCodeServe() {
  const children: ReturnType<typeof fakeChild>[] = []
  const spawn = () => {
    const child = fakeChild()
    children.push(child)
    return child
  }
  // SAFETY: The adapter only reads stdout, stderr, lifecycle events and the
  // kill surface that killTree needs; the double implements each of them.
  return { children, spawn: spawn as unknown as typeof spawnCli }
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => {
      child.exitCode = 0
      child.emit('close', 0)
      return true
    }),
  })
  return child
}

type RequestRecord = { method: string; url: string; body: JsonRpcValue | undefined }

function serverPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  return address.port
}

async function serveOpenCode(beforeSessionResponse?: () => Promise<void>): Promise<{
  baseUrl: string
  requests: RequestRecord[]
  broadcast(event: OpenCodeWireEvent): void
  endStreams(): void
  waitFor(url: string): Promise<RequestRecord>
}> {
  const requests: RequestRecord[] = []
  const streams = new Set<ServerResponse>()
  const waiters: { url: string; resolve: (request: RequestRecord) => void }[] = []
  const session = {
    id: 'session-1',
    projectID: 'project-1',
    directory: 'C:\\repo',
    title: 'TasteCode session',
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
    // opencode 1.18.31 answers v2's health check beside v1.
    if (request.url === '/api/health') return json(response, { healthy: true })
    if (request.url?.startsWith('/config/providers')) {
      return json(response, {
        providers: [
          {
            id: 'provider-1',
            name: 'Provider One',
            env: [],
            models: {
              'model-1': {
                id: 'model-1',
                name: 'Model One',
                variants: { low: {}, high: {} },
                limit: { context: 32_000, output: 8_000 },
              },
              'model-retired': { id: 'model-retired', name: 'Retired', status: 'deprecated' },
            },
          },
        ],
        default: { 'provider-1': 'model-1' },
      })
    }
    if (request.method === 'GET' && request.url?.startsWith('/session/session-1')) {
      await beforeSessionResponse?.()
      return json(response, session)
    }
    if (
      request.method === 'POST' &&
      request.url &&
      new URL(request.url, 'http://mock').pathname === '/session'
    ) {
      await beforeSessionResponse?.()
      return json(response, session)
    }
    if (request.url?.includes('/prompt_async')) {
      response.writeHead(204)
      return response.end()
    }
    return json(response, true)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = serverPort(server)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    broadcast(event) {
      for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    endStreams() {
      for (const response of streams) response.end()
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
  broadcast(event: OpenCodeV2Event): void
  endStreams(): void
  waitFor(url: string): Promise<RequestRecord>
  releaseHeldPermissionReply(): Promise<void>
}> {
  const requests: RequestRecord[] = []
  const streams = new Set<ServerResponse>()
  const waiters: { url: string; resolve: (request: RequestRecord) => void }[] = []
  let heldPermissionReply: ServerResponse | undefined
  const session = {
    id: 'session-v2',
    title: 'TasteCode v2 session',
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
    // A server that has dropped v1, so the adapter speaks v2 to it.
    if (request.url?.startsWith('/session/status')) {
      response.writeHead(404)
      return response.end()
    }
    if (request.url === '/api/health') return json(response, { healthy: true })
    if (request.url?.startsWith('/config/providers')) {
      return json(response, {
        providers: [
          {
            id: 'provider-1',
            name: 'Provider One',
            models: {
              'model-1': { id: 'model-1', name: 'Model One' },
              'model-2': { id: 'model-2', name: 'Model Two' },
            },
          },
        ],
        default: { 'provider-1': 'model-2' },
      })
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
  const port = serverPort(server)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    broadcast(event) {
      for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    endStreams() {
      for (const response of streams) response.end()
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

function permissionAsked(id: string): OpenCodeV2Event {
  return {
    type: 'permission.asked',
    data: { id, sessionID: 'session-v2', action: 'bash', resources: ['pnpm test'] },
  }
}

function isPermissionReply(request: RequestRecord): boolean {
  return request.method === 'POST' && request.url.includes('/permission/')
}

async function requestBody(request: IncomingMessage): Promise<JsonRpcValue | undefined> {
  let body = ''
  for await (const chunk of request) body += chunk
  return body ? JsonRpcValueSchema.parse(JSON.parse(body)) : undefined
}

/** A read-only OpenCode v2 server that answers each path prefix with fixed JSON. */
async function serveCatalog(
  routes: Record<string, JsonRpcValue>,
): Promise<{ baseUrl: string; urls: string[] }> {
  const urls: string[] = []
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    urls.push(url)
    if (url === '/api/health') return json(response, { healthy: true })
    const route = Object.keys(routes).find((path) => url.startsWith(path))
    if (route) return json(response, routes[route]!)
    response.writeHead(404)
    response.end()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${serverPort(server)}`, urls }
}

function json(response: ServerResponse, value: JsonRpcValue): void {
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
