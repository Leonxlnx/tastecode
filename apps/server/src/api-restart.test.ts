import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { CustomHarnessStore } from './custom-harnesses.js'
import { McpConfigStore } from './mcp-config.js'
import { ModelConnectionStore } from './model-connections.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

type RequestBody = {
  model: string
  messages: Array<{ role: string; content: string | null; tool_call_id?: string }>
}

describe('direct API restart', () => {
  it('restores each connection, selected model and tool context from a reopened database', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tastecode-api-restart-'))
    const workspace = path.join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(path.join(workspace, 'alpha.txt'), 'Alpha project context')
    writeFileSync(path.join(workspace, 'beta.txt'), 'Beta project context')
    const credentials = new Map<string, string>()
    const connections = new ModelConnectionStore(path.join(root, 'providers.json'), {
      has: (reference) => credentials.has(reference),
      write: (reference, value) => {
        credentials.set(reference, value)
      },
      remove: (reference) => {
        credentials.delete(reference)
      },
    })
    const requests: Array<{
      connection: string
      authorization: string | undefined
      body: RequestBody
    }> = []
    const server = createServer(async (request, response) => {
      const connection = request.url?.match(/^\/(alpha|beta)\/v1\/chat\/completions$/)?.[1]
      if (request.method !== 'POST' || !connection) {
        response.writeHead(404).end()
        return
      }
      try {
        let raw = ''
        for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw) as RequestBody
        requests.push({ connection, authorization: request.headers.authorization, body })
        const first = body.messages.length === 1
        const delta = first
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `read-${connection}`,
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ path: `${connection}.txt` }),
                  },
                },
              ],
            }
          : {
              content: `${connection} answer ${body.messages.at(-1)?.role === 'tool' ? 'before' : 'after'} restart`,
            }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        )
      } catch {
        response.writeHead(400).end()
      }
    })
    let store: Store | undefined
    let orchestrator: Orchestrator | undefined
    const completed = new Map<string, number>()
    const events: DomainEvent[] = []
    const logs: string[] = []
    const open = () => {
      store = new Store(path.join(root, 'tastecode.db'))
      orchestrator = new Orchestrator(store, {
        onEvent: (threadId, event) => {
          events.push(event)
          if (event.type === 'turn.completed' && event.status === 'completed')
            completed.set(threadId, (completed.get(threadId) ?? 0) + 1)
        },
        onLog: (line) => {
          logs.push(line)
        },
        onLogin: () => {},
        modelConnections: connections,
        readCredential: (reference) => {
          const value = credentials.get(reference)
          if (!value) throw new Error('missing test credential')
          return value
        },
        mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
        customHarnesses: new CustomHarnessStore(path.join(root, 'harnesses.json')),
        worktreeRoot: path.join(root, 'worktrees'),
      })
      return { store, orchestrator }
    }
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind')
      for (const id of ['alpha', 'beta']) {
        connections.upsert({
          id,
          displayName: id,
          preset: 'custom',
          transport: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/${id}/v1`,
          enabled: true,
          defaultModel: `${id}-default`,
        })
        connections.setCredential(id, `test-only-${id}-credential`)
      }
      const first = open()
      const threads = []
      for (const id of ['alpha', 'beta']) {
        const thread = await first.orchestrator.startThread('api', workspace, {
          connectionId: id,
          model: `${id}-selected`,
          approval: 'full',
        })
        threads.push(thread)
        await first.orchestrator.submitTurn(thread.id, `Read ${id}.txt`)
        await vi.waitFor(() => expect(completed.get(thread.id)).toBe(1))
        expect(first.store.thread(thread.id)?.connectionId).toBe(id)
        expect(first.store.threadRuntimeState(thread.id)).toMatchObject({
          version: 1,
          model: `${id}-selected`,
        })
        const connection = connections.get(id)
        connections.upsert({ ...connection, defaultModel: 'changed-default-must-not-be-used' })
      }
      await first.orchestrator.disposeAll()
      first.store.close()
      orchestrator = undefined
      store = undefined
      const reopened = open()
      for (const thread of threads) {
        const id = thread.connectionId!
        await reopened.orchestrator.submitTurn(thread.id, `Continue ${id} from the saved context`)
        await vi.waitFor(() => expect(completed.get(thread.id)).toBe(2))
        const resumed = requests.filter((request) => request.connection === id)
        expect(resumed).toHaveLength(3)
        expect(resumed.every((request) => request.body.model === `${id}-selected`)).toBe(true)
        expect(
          resumed.every((request) => request.authorization === `Bearer test-only-${id}-credential`),
        ).toBe(true)
        expect(resumed[2]!.body.messages).toMatchObject([
          { role: 'user', content: expect.stringContaining(`Read ${id}.txt`) },
          {
            role: 'assistant',
            tool_calls: [{ id: `read-${id}`, function: { name: 'read_file' } }],
          },
          {
            role: 'tool',
            tool_call_id: `read-${id}`,
            content: expect.stringContaining(
              `${id === 'alpha' ? 'Alpha' : 'Beta'} project context`,
            ),
          },
          { role: 'assistant', content: `${id} answer before restart` },
          { role: 'user', content: `Continue ${id} from the saved context` },
        ])
        const snapshot = JSON.stringify(reopened.store.threadRuntimeState(thread.id))
        expect(snapshot).toContain(`${id} answer after restart`)
        expect(snapshot).not.toContain(
          id === 'alpha' ? 'Beta project context' : 'Alpha project context',
        )
        for (const credential of credentials.values()) expect(snapshot).not.toContain(credential)
      }
      expect(
        events.filter((event) => event.type === 'turn.completed').map((event) => event.status),
      ).toEqual(['completed', 'completed', 'completed', 'completed'])
      await reopened.orchestrator.disposeAll()
      reopened.store.close()
      orchestrator = undefined
      store = undefined
      const database = readFileSync(path.join(root, 'tastecode.db'))
      for (const credential of credentials.values()) {
        expect(database.includes(Buffer.from(credential))).toBe(false)
        expect(JSON.stringify(logs)).not.toContain(credential)
      }
    } finally {
      await orchestrator?.disposeAll()
      store?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  })
})
