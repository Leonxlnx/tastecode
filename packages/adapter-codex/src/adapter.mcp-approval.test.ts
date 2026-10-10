import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, DomainEvent } from '@harness/contracts'
import type { JsonRpcValue } from '@harness/proc'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'
import type { McpServerElicitationRequestParams } from './generated/v2/McpServerElicitationRequestParams'

const proc = vi.hoisted(() => ({ rpc: undefined as FakeCodexRpc | undefined }))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      if (!proc.rpc) throw new Error('fake Codex RPC was not installed')
      return proc.rpc
    }
  },
}))

/** Sanitized MCP tool approval captured from Codex 0.162.1 in `ask` mode. */
const capturedToolApproval = {
  threadId: 'captured-thread',
  turnId: 'captured-turn',
  serverName: 'elicit',
  mode: 'form',
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['session', 'always'],
    tool_description: 'Ask the user for their name',
    tool_params: { question: 'name?' },
    tool_params_display: [{ name: 'question', value: 'name?', display_name: 'question' }],
  },
  message: 'Allow the elicit MCP server to run tool "ask"?',
  requestedSchema: { type: 'object', properties: {} },
} satisfies McpServerElicitationRequestParams

const serverElicitation = {
  threadId: 'captured-thread',
  turnId: 'captured-turn',
  serverName: 'elicit',
  mode: 'form',
  _meta: null,
  message: 'What is your name?',
  requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
} satisfies McpServerElicitationRequestParams

async function adapterWithRequests() {
  const rpc = new FakeCodexRpc()
  proc.rpc = rpc
  const adapter = new CodexAdapter()
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  await adapter.start()
  const requested = (): ApprovalRequest[] =>
    events.flatMap((event) => (event.type === 'approval.requested' ? [event.request] : []))
  const ask = (params: JsonRpcValue) =>
    rpc.emitServerRequest('mcpServer/elicitation/request', params)
  return { adapter, rpc, events, requested, ask }
}

let open: CodexAdapter | undefined
afterEach(async () => {
  await open?.dispose()
  open = undefined
})

describe('Codex MCP tool approval', () => {
  it('shows the captured tool approval as a card instead of declining it', async () => {
    const { adapter, requested, ask } = await adapterWithRequests()
    open = adapter
    let answered = false
    void ask(capturedToolApproval).then(() => (answered = true))
    await Promise.resolve()

    expect(answered).toBe(false)
    expect(requested()).toEqual([
      {
        id: expect.any(String),
        kind: 'permissions',
        command: 'Allow the elicit MCP server to run tool "ask"?\n{\n  "question": "name?"\n}',
        reason: 'Ask the user for their name',
        createdAt: expect.any(Number),
      },
    ])
  })

  it.each([
    ['approve', { action: 'accept', content: null, _meta: null }],
    ['approve-session', { action: 'accept', content: null, _meta: { persist: 'session' } }],
    ['deny', { action: 'decline', content: null, _meta: null }],
    ['abort', { action: 'cancel', content: null, _meta: null }],
  ] as const)('answers %s with the elicitation response shape', async (decision, reply) => {
    const { adapter, requested, ask } = await adapterWithRequests()
    open = adapter
    const answer = ask(capturedToolApproval)
    await Promise.resolve()

    adapter.respondToApproval(requested()[0]!.id, decision)

    await expect(answer).resolves.toEqual(reply)
  })

  it('approves once when Codex does not offer to remember the tool for the session', async () => {
    const { adapter, requested, ask } = await adapterWithRequests()
    open = adapter
    const answer = ask({
      ...capturedToolApproval,
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} },
    })
    await Promise.resolve()

    expect(requested()[0]).toMatchObject({ command: capturedToolApproval.message })
    expect(requested()[0]).not.toHaveProperty('reason')
    adapter.respondToApproval(requested()[0]!.id, 'approve-session')

    await expect(answer).resolves.toEqual({ action: 'accept', content: null, _meta: null })
  })

  it('stops the turn after Stop the turn, since Codex only skips the cancelled tool', async () => {
    const { adapter, rpc, requested, ask } = await adapterWithRequests()
    open = adapter
    void ask(capturedToolApproval)
    await Promise.resolve()

    adapter.respondToApproval(requested()[0]!.id, 'abort')
    await vi.waitFor(() =>
      expect(rpc.calls).toContainEqual({
        method: 'turn/interrupt',
        params: { threadId: 'captured-thread', turnId: 'captured-turn' },
      }),
    )
  })

  it('declines an unanswered tool approval in its response shape when the turn ends', async () => {
    const { adapter, rpc, events, ask } = await adapterWithRequests()
    open = adapter
    const answer = ask(capturedToolApproval)
    await Promise.resolve()

    rpc.emitNotification('turn/completed', {
      threadId: 'captured-thread',
      turn: { id: 'captured-turn', status: 'completed' },
    })

    await expect(answer).resolves.toEqual({ action: 'decline', content: null, _meta: null })
    expect(events.map((event) => event.type)).toContain('approval.resolved')
  })

  it('declines an elicitation the MCP server starts itself in a shape Codex accepts', async () => {
    const { adapter, requested, ask } = await adapterWithRequests()
    open = adapter

    await expect(ask(serverElicitation)).resolves.toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    })
    expect(requested()).toEqual([])
  })
})
