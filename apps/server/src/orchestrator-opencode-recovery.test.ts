import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { providerRuntime } from './adapters.js'
import { CustomHarnessStore } from './custom-harnesses.js'
import { McpConfigStore } from './mcp-config.js'
import { ModelConnectionStore } from './model-connections.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

const endpoint = vi.hoisted(() => ({ url: '', constructions: 0, disconnects: 0, disposals: 0 }))
// Only the endpoint is injected; the real adapter, runtime and orchestrator own recovery.
vi.mock('@harness/adapter-opencode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@harness/adapter-opencode')>()
  return {
    ...actual,
    OpenCodeAdapter: class extends actual.OpenCodeAdapter {
      constructor(options: ConstructorParameters<typeof actual.OpenCodeAdapter>[0]) {
        super({ ...options, baseUrl: endpoint.url })
        endpoint.constructions += 1
        this.on('disconnected', () => endpoint.disconnects++)
      }
      override async dispose(): Promise<void> {
        endpoint.disposals += 1
        await super.dispose()
      }
    },
  }
})

async function mockOpenCode(protocol: 'v1' | 'v2', directory: string) {
  const streams = new Set<ServerResponse>()
  const prompts: string[] = []
  let creations = 0
  let resumes = 0
  let holdSessionResponse = false
  let releaseSessionResponse: (() => void) | undefined
  const session = {
    id: 'local-session',
    projectID: 'local-project',
    directory,
    title: 'Recovery test',
    version: '1.18.11',
    time: { created: 100, updated: 100 },
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (url === (protocol === 'v2' ? '/api/event' : '/event')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': connected\n\n')
      streams.add(response)
      response.on('close', () => streams.delete(response))
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    response.setHeader('content-type', 'application/json')
    if (url === '/api/health') {
      response.end(JSON.stringify({ healthy: protocol === 'v2' }))
      return
    }
    const sessionRoot = protocol === 'v2' ? '/api/session' : '/session'
    if (url === sessionRoot && request.method === 'POST') creations += 1
    if (url === `${sessionRoot}/${session.id}` && request.method === 'GET') resumes += 1
    if (url === sessionRoot || url === `${sessionRoot}/${session.id}`) {
      const finish = () =>
        response.end(JSON.stringify(protocol === 'v2' ? { data: session } : session))
      if (holdSessionResponse) {
        holdSessionResponse = false
        releaseSessionResponse = () => {
          releaseSessionResponse = undefined
          finish()
        }
      } else finish()
      return
    }
    if (/\/prompt(?:_async)?$/.test(url)) prompts.push(body)
    response.end(JSON.stringify(true))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local test port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    prompts,
    sessions: () => ({ creations, resumes }),
    activeStreams: () => streams.size,
    holdSessionResponse() {
      holdSessionResponse = true
    },
    sessionResponseHeld: () => releaseSessionResponse !== undefined,
    releaseSessionResponse() {
      releaseSessionResponse?.()
    },
    disconnect() {
      for (const response of streams) response.end()
    },
    complete() {
      const events =
        protocol === 'v2'
          ? [{ type: 'session.execution.succeeded', data: { sessionID: session.id } }]
          : [
              {
                type: 'session.status',
                properties: { sessionID: session.id, status: { type: 'busy' } },
              },
              { type: 'session.idle', properties: { sessionID: session.id } },
            ]
      for (const event of events) {
        for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    },
    async close() {
      releaseSessionResponse?.()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe.each(['v1', 'v2'] as const)('OpenCode %s connection recovery', (protocol) => {
  it.each([false, true])(
    'resumes after SSE EOF and sends the next prompt once (queued: %s)',
    async (queued) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'harness-opencode-recovery-'))
      const server = await mockOpenCode(protocol, root)
      endpoint.url = server.url
      endpoint.constructions = 0
      const events: DomainEvent[] = []
      const store = new Store(':memory:')
      const orchestrator = new Orchestrator(store, {
        onEvent: (_threadId, event) => events.push(event),
        onLog: () => {},
        onLogin: () => {},
        runtimeFor: providerRuntime,
        worktreeRoot: path.join(root, 'worktrees'),
        mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
        modelConnections: new ModelConnectionStore(path.join(root, 'models.json')),
        customHarnesses: new CustomHarnessStore(path.join(root, 'harnesses.json')),
      })
      try {
        const thread = await orchestrator.startThread('opencode', root)
        await orchestrator.submitTurn(thread.id, 'First prompt', [], {}, 'first')
        await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
        if (queued) {
          await expect(
            orchestrator.submitTurn(thread.id, 'Second prompt', [], {}, 'second'),
          ).resolves.toMatchObject({ queued: true })
        }
        server.disconnect()
        await vi.waitFor(() =>
          expect(
            events.some((event) => event.type === 'turn.completed' && event.status === 'failed'),
          ).toBe(true),
        )
        if (!queued) await orchestrator.submitTurn(thread.id, 'Second prompt', [], {}, 'second')
        await vi.waitFor(() => expect(server.prompts).toHaveLength(2))
        expect(server.prompts[0]).toContain('First prompt')
        expect(server.prompts[1]).toContain('Second prompt')
        expect(endpoint.constructions).toBe(2)
        expect(server.sessions()).toEqual({ creations: 1, resumes: 1 })
        expect(store.thread(thread.id)?.closedAt).toBeUndefined()
        expect(orchestrator.queue(thread.id).items).toEqual([])
        server.complete()
        await vi.waitFor(() => expect(orchestrator.isTurnRunning(thread.id)).toBe(false))
        expect(
          events.filter((event) => event.type === 'turn.completed').map((event) => event.status),
        ).toEqual(['failed', 'completed'])
        expect(server.prompts).toHaveLength(2)
      } finally {
        await orchestrator.disposeAll()
        store.close()
        await server.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

describe('OpenCode opening stream recovery', () => {
  it.each([false, true])(
    'does not retain an EOF runtime before session response (resume: %s)',
    async (resume) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'harness-opencode-opening-'))
      const server = await mockOpenCode('v1', root)
      endpoint.url = server.url
      endpoint.constructions = endpoint.disposals = endpoint.disconnects = 0
      const store = new Store(':memory:')
      const createOrchestrator = () =>
        new Orchestrator(store, {
          onEvent: () => {},
          onLog: () => {},
          onLogin: () => {},
          runtimeFor: providerRuntime,
          worktreeRoot: path.join(root, 'worktrees'),
          mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
          modelConnections: new ModelConnectionStore(path.join(root, 'models.json')),
          customHarnesses: new CustomHarnessStore(path.join(root, 'harnesses.json')),
        })
      let orchestrator = createOrchestrator()
      try {
        if (resume) {
          await orchestrator.startThread('opencode', root)
          await orchestrator.disposeAll()
          orchestrator = createOrchestrator()
        }
        const baseline = { constructions: endpoint.constructions, disposals: endpoint.disposals }
        server.holdSessionResponse()
        const opening = resume
          ? orchestrator.submitTurn('opencode-local-session', 'Opening prompt')
          : orchestrator.startThread('opencode', root)
        const rejected = expect(opening).rejects.toThrow('OpenCode event stream disconnected')
        await vi.waitFor(() => expect(server.sessionResponseHeld()).toBe(true))
        server.disconnect()
        await vi.waitFor(() => expect(endpoint.disconnects).toBe(1))
        server.releaseSessionResponse()
        await rejected
        expect(orchestrator.isRunning('opencode-local-session')).toBe(false)
        expect(endpoint.disposals).toBe(baseline.disposals + 1)
        await vi.waitFor(() => expect(server.activeStreams()).toBe(0))
        expect(store.threads()).toHaveLength(resume ? 1 : 0)
        if (!resume) await orchestrator.startThread('opencode', root)
        await orchestrator.submitTurn('opencode-local-session', 'Recovered prompt')
        await vi.waitFor(() => expect(server.prompts).toHaveLength(1))
        expect(server.prompts[0]).toContain('Recovered prompt')
        expect(endpoint.constructions).toBe(baseline.constructions + 2)
        server.complete()
        await vi.waitFor(() =>
          expect(orchestrator.isTurnRunning('opencode-local-session')).toBe(false),
        )
      } finally {
        server.releaseSessionResponse()
        await orchestrator.disposeAll()
        store.close()
        await server.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
