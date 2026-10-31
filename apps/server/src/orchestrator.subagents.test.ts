import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_MCP_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { GROK_MCP_CAPABILITIES } from '@harness/adapter-grok/mcp'
import { OPENCODE_MCP_CAPABILITIES } from '@harness/adapter-opencode/inventory'
import type { Capabilities, DomainEvent, Item, ProviderId } from '@harness/contracts'
import type { AgentSession, ProviderRuntime, StartOptions } from './adapters.js'
import { AGENT_TOOLS_SERVER_ID } from './agent-tools-mcp.js'
import { McpConfigStore } from './mcp-config.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'
import { SUBAGENT_INSTRUCTIONS } from './subagent-broker.js'

const CAPABILITIES: Capabilities = {
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images: false,
}

class FakeSession implements AgentSession {
  readonly capabilities = CAPABILITIES
  sent: string[] = []
  interrupted = false
  disposed = false
  #listeners: Array<(event: DomainEvent) => void> = []
  constructor(readonly turnId: string) {}
  emit(event: DomainEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
  async sendTurn(_threadId: string, text: string): Promise<string> {
    this.sent.push(text)
    return this.turnId
  }
  async interrupt(): Promise<void> {
    this.interrupted = true
  }
  respondToApproval(): void {}
  dispose(): void {
    this.disposed = true
  }
  on(_event: 'event' | 'log', listener: (value: never) => void): void {
    this.#listeners.push(listener as (event: DomainEvent) => void)
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function harness() {
  const store = new Store(':memory:')
  const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-subagents-'))
  const sessions: FakeSession[] = []
  const started: Array<{ provider: ProviderId; workspacePath: string; options: StartOptions }> = []
  const parentEvents: Array<{ threadId: string; event: DomainEvent }> = []
  const childEvents: Array<{ threadId: string; parentThreadId: string; event: DomainEvent }> = []
  const runtimeFor = (provider: ProviderId): ProviderRuntime => ({
    async start(workspacePath, options) {
      started.push({ provider, workspacePath, options })
      const session = new FakeSession(`turn-${sessions.length + 1}`)
      sessions.push(session)
      return {
        thread: { id: `thread-${sessions.length}`, provider, workspacePath, createdAt: Date.now() },
        session,
      }
    },
    async listModels() {
      return [
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          isDefault: true,
          reasoningEfforts: ['low', 'high'],
          serviceTiers: [],
        },
      ]
    },
  })
  const orchestrator = new Orchestrator(store, {
    onEvent: (threadId, event) => parentEvents.push({ threadId, event }),
    onSubagentEvent: (threadId, parentThreadId, event) =>
      childEvents.push({ threadId, parentThreadId, event }),
    agentTools: true,
    onLog: () => {},
    onLogin: () => {},
    mcpConfig: new McpConfigStore(path.join(directory, 'mcp.json')),
    readCredential: (reference) => `secret:${reference}`,
    runtimeFor,
    providerServices: {
      'claude-code': {
        projectInventory: {
          mcpCapabilities: CLAUDE_MCP_CAPABILITIES,
          discover: async () => ({ commands: [], servers: [] }),
        },
      },
      grok: {
        projectInventory: {
          mcpCapabilities: GROK_MCP_CAPABILITIES,
          skillCapabilities: { inventory: true, configure: false, install: false },
          discover: async () => ({ commands: [], servers: [], skills: [] }),
        },
      },
      opencode: {
        projectInventory: {
          mcpCapabilities: OPENCODE_MCP_CAPABILITIES,
          skillCapabilities: { inventory: true, configure: false, install: false },
          discover: async () => ({ commands: [], servers: [], skills: [] }),
        },
      },
    },
  })
  cleanups.push(
    () => orchestrator.disposeAll(),
    () => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }),
  )
  return { store, orchestrator, sessions, started, parentEvents, childEvents, directory }
}

/** Calls one agent tool the way an engine does: JSON-RPC over HTTP with the chat's token. */
async function callTool(options: StartOptions, name: string, args: Record<string, unknown>) {
  const server = options.mcpServers?.find((entry) => entry.id === AGENT_TOOLS_SERVER_ID)
  if (!server || server.transport.type !== 'http') throw new Error('no agent tools')
  const header = server.transport.headers?.['Authorization']
  if (!header || typeof header === 'string' || header.source !== 'credential') {
    throw new Error('no credential header')
  }
  const response = await fetch(server.transport.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: options.mcpCredentials?.[header.credentialRef] ?? '',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean }
  }
  const text = body.result.content[0]!.text
  return body.result.isError ? { error: text } : (JSON.parse(text) as Record<string, unknown>)
}

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(check()).toBe(true)
}

const subagentRows = (events: Array<{ threadId: string; event: DomainEvent }>, threadId: string) =>
  events.flatMap(({ threadId: id, event }) =>
    id === threadId && event.type === 'item.completed' && event.item.subagent ? [event.item] : [],
  ) as Array<Item & { subagent: NonNullable<Item['subagent']> }>

/** A parent in a running turn whose sub-agent on another provider runs its task. */
async function runningChild(h: ReturnType<typeof harness>, task = 'Review src/a.ts') {
  await h.orchestrator.listModels('claude-code')
  const first = h.sessions.length
  // Not a Git checkout, so no checkpoint slows the child's first turn.
  const parent = await h.orchestrator.startThread('codex', h.directory, { approval: 'full' })
  const parentOptions = h.started[first]!.options
  h.sessions[first]!.emit({
    type: 'turn.started',
    turn: { id: `turn-${first}`, threadId: parent.id, status: 'running', createdAt: Date.now() },
  })
  await expect(
    callTool(parentOptions, 'start_agent', { provider: 'claude-code', task }),
  ).resolves.toMatchObject({ status: 'running' })
  await until(() => h.sessions[first + 1]?.sent.length === 1)
  const childSession = h.sessions[first + 1]!
  const childId = `thread-${first + 2}`
  childSession.emit({
    type: 'turn.started',
    turn: { id: childSession.turnId, threadId: childId, status: 'running', createdAt: Date.now() },
  })
  return { parent, parentOptions, childSession, childId }
}

describe('sub-agents on another provider', () => {
  it('runs a child on another provider in the parent checkout and hands its answer back', async () => {
    const h = harness()
    await h.orchestrator.listModels('claude-code')
    const workspace = h.directory
    const parent = await h.orchestrator.startThread('codex', workspace, { approval: 'full' })
    const parentOptions = h.started[0]!.options
    const reserved = parentOptions.mcpServers?.find((entry) => entry.id === AGENT_TOOLS_SERVER_ID)
    expect(reserved?.transport).toMatchObject({ type: 'http' })
    expect(Object.values(parentOptions.mcpCredentials ?? {})).toContainEqual(
      expect.stringMatching(/^Bearer [A-Za-z0-9_-]{20,}$/),
    )

    // Tools answer only while the chat runs a turn.
    await expect(
      callTool(parentOptions, 'start_agent', { provider: 'claude-code', task: 'Review' }),
    ).resolves.toEqual({ error: 'Sub-agents start from a running turn.' })
    h.sessions[0]!.emit({
      type: 'turn.started',
      turn: { id: 'parent-turn', threadId: parent.id, status: 'running', createdAt: Date.now() },
    })
    await expect(callTool(parentOptions, 'list_agent_models', {})).resolves.toMatchObject({
      providers: [
        {
          provider: 'claude-code',
          models: [{ id: 'gpt-5.5', name: 'GPT-5.5', default: true, efforts: ['low', 'high'] }],
        },
      ],
    })
    await expect(
      callTool(parentOptions, 'start_agent', {
        provider: 'claude-code',
        model: 'gpt-5.5',
        name: 'Reviewer',
        task: 'Review src/a.ts',
      }),
    ).resolves.toEqual({
      agent_id: 'a1',
      status: 'running',
      provider: 'claude-code',
      model: 'gpt-5.5',
    })

    await until(() => h.sessions[1]?.sent.length === 1)
    const child = h.started[1]!
    expect(child.provider).toBe('claude-code')
    expect(child.workspacePath).toBe(workspace)
    expect(child.options).toMatchObject({ approval: 'full', model: 'gpt-5.5' })
    expect(child.options.instructions).toContain(SUBAGENT_INSTRUCTIONS)
    // One level deep: the child gets no agent tools of its own.
    expect(child.options.mcpServers?.some((entry) => entry.id === AGENT_TOOLS_SERVER_ID)).not.toBe(
      true,
    )
    expect(h.sessions[1]!.sent).toEqual(['Review src/a.ts'])
    const childId = 'thread-2'
    // The child is stored, owned by the parent, and kept out of every chat list.
    expect(h.store.thread(childId)).toMatchObject({ ownerThreadId: parent.id, ephemeral: true })
    expect(h.store.threads().map((thread) => thread.id)).toEqual([parent.id])
    // Provider history import will not list its session as a chat of its own.
    expect(h.store.providerHistories()).toContainEqual(
      expect.objectContaining({
        provider: 'claude-code',
        threadId: childId,
        session: expect.objectContaining({ internal: true }),
      }),
    )

    const childSession = h.sessions[1]!
    childSession.emit({
      type: 'turn.started',
      turn: {
        id: childSession.turnId,
        threadId: childId,
        status: 'running',
        createdAt: Date.now(),
      },
    })
    childSession.emit({
      type: 'item.completed',
      item: {
        id: 'answer',
        turnId: childSession.turnId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Found two bugs.',
        createdAt: Date.now(),
      },
    })
    childSession.emit({ type: 'turn.completed', turnId: childSession.turnId, status: 'completed' })

    // The child's events take their own channel; the parent's stream never sees them.
    expect(h.childEvents.length).toBeGreaterThan(0)
    expect(h.childEvents.every((entry) => entry.parentThreadId === parent.id)).toBe(true)
    expect(h.parentEvents.some((entry) => entry.threadId === childId)).toBe(false)

    await expect(
      callTool(parentOptions, 'wait_for_agents', { timeout_seconds: 5 }),
    ).resolves.toMatchObject({
      agents: [
        { agent_id: 'a1', status: 'completed', name: 'Reviewer', result: 'Found two bugs.' },
      ],
    })
    const row = subagentRows(h.parentEvents, parent.id).at(-1)!
    expect(row).toMatchObject({ type: 'tool_call', turnId: 'parent-turn' })
    expect(row.subagent).toMatchObject({
      id: 'a1',
      name: 'Reviewer',
      state: 'completed',
      threadId: childId,
      provider: 'claude-code',
      model: 'gpt-5.5',
      summary: 'Found two bugs.',
    })
    expect(h.orchestrator.subagents(parent.id)).toEqual([
      expect.objectContaining({ itemId: row.id, subagent: expect.objectContaining({ id: 'a1' }) }),
    ])
  })

  it('offers no agent tools to a provider without them', async () => {
    const h = harness()
    await h.orchestrator.listModels('claude-code')
    await h.orchestrator.startThread('grok', process.cwd())
    expect(
      h.started[0]!.options.mcpServers?.some((entry) => entry.id === AGENT_TOOLS_SERVER_ID),
    ).not.toBe(true)
  })

  it('asks the user before a start in a chat that asks first', async () => {
    const h = harness()
    await h.orchestrator.listModels('claude-code')
    const asking = await h.orchestrator.startThread('codex', h.directory, { approval: 'ask' })
    h.sessions[0]!.emit({
      type: 'turn.started',
      turn: { id: 'ask-turn', threadId: asking.id, status: 'running', createdAt: Date.now() },
    })
    await expect(
      callTool(h.started[0]!.options, 'start_agent', { provider: 'claude-code', task: 'x' }),
    ).resolves.toMatchObject({ agent_id: 'a1', status: 'waiting_for_approval' })
    const asked = h.parentEvents.flatMap(({ threadId, event }) =>
      threadId === asking.id && event.type === 'approval.requested' ? [event.request] : [],
    )
    expect(asked).toHaveLength(1)
    expect(h.sessions).toHaveLength(1)
    // The chat's own agent never hears this answer; TasteCode starts the child.
    h.orchestrator.respondToApproval(asking.id, asked[0]!.id, 'approve')
    await until(() => h.sessions[1]?.sent.length === 1)
    expect(h.started[1]!.options).toMatchObject({ approval: 'ask' })
    expect(h.parentEvents).toContainEqual({
      threadId: asking.id,
      event: { type: 'approval.resolved', id: asked[0]!.id },
    })
  })

  it('stops a running child when the parent stops, and on Stop all', async () => {
    const h = harness()
    const { parent, childSession } = await runningChild(h)
    await h.orchestrator.interrupt(parent.id)
    expect(h.sessions[0]!.interrupted).toBe(true)
    expect(childSession.interrupted).toBe(true)
    expect(subagentRows(h.parentEvents, parent.id).at(-1)!.subagent.state).toBe('interrupted')

    const second = await runningChild(h, 'Look again')
    await h.orchestrator.panicStop()
    expect(second.childSession.interrupted).toBe(true)
    expect(h.store.subagents.ofParent(second.parent.id)[0]).toMatchObject({ state: 'stopped' })
  })

  it('ends the children with a closed parent and deletes them with it', async () => {
    const h = harness()
    const { parent, childSession, childId } = await runningChild(h)
    await h.orchestrator.close(parent.id)
    expect(childSession.disposed).toBe(true)
    expect(subagentRows(h.parentEvents, parent.id).at(-1)!.subagent.state).toBe('interrupted')
    // Its transcript stays readable until the parent goes.
    expect(h.store.thread(childId)).toBeDefined()
    h.store.deleteThread(parent.id)
    h.orchestrator.forgetDeletedThread(parent.id)
    expect(h.store.thread(childId)).toBeUndefined()
    expect(h.orchestrator.subagents(parent.id)).toEqual([])
  })

  it('reserves the agent tools server id', async () => {
    const h = harness()
    expect(() =>
      h.orchestrator.addMcpServer('codex', process.cwd(), {
        id: AGENT_TOOLS_SERVER_ID,
        enabled: true,
        transport: { type: 'http', url: 'http://127.0.0.1:1/' },
      }),
    ).toThrow('reserved')
  })
})
