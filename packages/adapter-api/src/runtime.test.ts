import type { DomainEvent } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { ApiAgentSession, type ApiStreamEvent, type ApiTransport } from './runtime.js'

function transport(...events: ApiStreamEvent[]): ApiTransport {
  return async function* () {
    yield* events
  }
}

describe('ApiAgentSession', () => {
  it('adds shared instructions to the first provider prompt only', async () => {
    const seen: string[][] = []
    const session = new ApiAgentSession({
      model: 'test-model',
      instructions: 'Answer plainly.',
      transport: async function* ({ messages }) {
        seen.push(
          messages.filter((message) => message.role === 'user').map((message) => message.content),
        )
        yield { type: 'finish', reason: 'stop' }
      },
    })
    const thread = session.startThread('C:\\repo', 'connection-1')
    const first = await session.sendTurn(thread.id, 'First')
    await session.waitForTurn(first)
    const second = await session.sendTurn(thread.id, 'Second')
    await session.waitForTurn(second)

    expect(seen[0]?.[0]).toContain('Answer plainly.')
    expect(seen[0]?.[0]).toContain('First')
    expect(seen[1]?.at(-1)).toBe('Second')
  })

  it('streams a provider-neutral turn and preserves resumable history', async () => {
    const session = new ApiAgentSession({
      model: 'test-model',
      transport: transport(
        { type: 'text', delta: 'Hello ' },
        { type: 'text', delta: 'world' },
        { type: 'state', value: [{ type: 'provider-state' }] },
        { type: 'finish', reason: 'stop' },
      ),
    })
    const events: unknown[] = []
    session.on('event', (event) => events.push(event))
    const thread = session.startThread('C:\\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Hi')
    await session.waitForTurn(turnId)

    expect(events).toContainEqual({
      type: 'turn.completed',
      turnId,
      status: 'completed',
    })
    expect(session.snapshot().messages).toEqual([
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: 'Hello world',
        toolCalls: [],
        transportState: [{ type: 'provider-state' }],
      },
    ])

    const resumed = new ApiAgentSession({
      model: 'test-model',
      transport: transport({ type: 'finish', reason: 'stop' }),
    })
    expect(resumed.resumeThread(session.snapshot())).toEqual(thread)
    const resumedTurn = await resumed.sendTurn(thread.id, 'Again')
    expect(resumedTurn).toBe(`${thread.id}-turn-2`)
    await resumed.waitForTurn(resumedTurn)
  })

  it('keeps shared instructions pending when an empty session is resumed', async () => {
    const original = new ApiAgentSession({
      model: 'test-model',
      instructions: 'Answer plainly.',
      transport: transport({ type: 'finish', reason: 'stop' }),
    })
    original.startThread('C:\\repo', 'connection-1')

    let firstPrompt = ''
    const resumed = new ApiAgentSession({
      model: 'test-model',
      instructions: 'Answer plainly.',
      transport: async function* ({ messages }) {
        firstPrompt = messages[0]?.content ?? ''
        yield { type: 'finish', reason: 'stop' }
      },
    })
    const thread = resumed.resumeThread(original.snapshot())
    const turn = await resumed.sendTurn(thread.id, 'First after restart')
    await resumed.waitForTurn(turn)

    expect(firstPrompt).toContain('Answer plainly.')
    expect(firstPrompt).toContain('First after restart')
  })

  it('does not repeat shared instructions after a populated session is resumed', async () => {
    const original = new ApiAgentSession({
      model: 'test-model',
      instructions: 'Answer plainly.',
      transport: transport({ type: 'finish', reason: 'stop' }),
    })
    const thread = original.startThread('C:\\repo', 'connection-1')
    const first = await original.sendTurn(thread.id, 'First')
    await original.waitForTurn(first)

    let prompts: string[] = []
    const resumed = new ApiAgentSession({
      model: 'test-model',
      instructions: 'Answer plainly.',
      transport: async function* ({ messages }) {
        prompts = messages
          .filter((message) => message.role === 'user')
          .map((message) => message.content)
        yield { type: 'finish', reason: 'stop' }
      },
    })
    resumed.resumeThread(original.snapshot())
    const second = await resumed.sendTurn(thread.id, 'Second after restart')
    await resumed.waitForTurn(second)

    expect(prompts[0]).toContain('Answer plainly.')
    expect(prompts[1]).toBe('Second after restart')
  })

  it('attributes usage to the configured model for persisted history', async () => {
    const session = new ApiAgentSession({
      model: 'gpt-5.6-luna',
      transport: transport(
        {
          type: 'usage',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 10,
            reasoningTokens: 0,
            totalTokens: 110,
            inputIncludesCached: true,
          },
        },
        { type: 'finish', reason: 'stop' },
      ),
    })
    const events: unknown[] = []
    session.on('event', (event) => events.push(event))
    const thread = session.startThread('C:\\repo', 'connection-1')
    const turn = await session.sendTurn(thread.id, 'Hi')
    await session.waitForTurn(turn)

    expect(events).toContainEqual({
      type: 'usage.updated',
      usage: expect.objectContaining({ model: 'gpt-5.6-luna', inputTokens: 100 }),
    })
  })

  it('runs approved tools through the injected TasteCode executor', async () => {
    let request = 0
    const seenMessages: unknown[] = []
    const session = new ApiAgentSession({
      model: 'test-model',
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
      transport: async function* (input) {
        seenMessages.push(structuredClone(input.messages))
        if (request++ === 0) {
          yield {
            type: 'tool_call',
            call: { id: 'call-1', name: 'read_file', input: { path: 'README.md' } },
          }
          yield { type: 'finish', reason: 'tool_calls' }
        } else {
          yield { type: 'text', delta: 'The file says hello.' }
          yield { type: 'finish', reason: 'stop' }
        }
      },
      reviewTool: () => ({ kind: 'permissions', path: 'README.md' }),
      executeTool: async () => ({ content: 'hello' }),
    })
    session.on('event', (event) => {
      if (event.type === 'approval.requested') {
        session.respondToApproval(event.request.id, 'approve')
      }
    })

    const thread = session.startThread('C:\\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Read it')
    await session.waitForTurn(turnId)

    expect(seenMessages[1]).toEqual([
      { role: 'user', content: 'Read it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'README.md' } }],
      },
      { role: 'tool', content: 'hello', toolCallId: 'call-1', isError: false },
    ])
  })

  it('classifies assistant text from the transport finish reason', async () => {
    let request = 0
    const events: unknown[] = []
    const session = new ApiAgentSession({
      model: 'test-model',
      transport: async function* () {
        if (request++ === 0) {
          yield { type: 'text', delta: 'I will inspect it.' }
          yield {
            type: 'tool_call',
            call: { id: 'call-1', name: 'read_file', input: { path: 'README.md' } },
          }
          yield { type: 'finish', reason: 'tool_calls' }
        } else {
          yield { type: 'text', delta: 'The file is valid.' }
          yield { type: 'finish', reason: 'stop' }
        }
      },
      executeTool: async () => ({ content: 'contents' }),
    })
    session.on('event', (event) => events.push(event))

    const thread = session.startThread('C:\\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Check it')
    await session.waitForTurn(turnId)

    const completed = events
      .filter(
        (event): event is Extract<DomainEvent, { type: 'item.completed' }> =>
          event.type === 'item.completed',
      )
      .map((event) => event.item)
    expect(completed).toMatchObject([
      { type: 'message', text: 'I will inspect it.', phase: 'commentary' },
      { type: 'tool_call', text: 'read_file\ncontents' },
      { type: 'message', text: 'The file is valid.', phase: 'final_answer' },
    ])
  })

  it('interrupts an active request without leaking transport errors', async () => {
    const secret = 'sk-test-secret'
    const events: unknown[] = []
    const logs: string[] = []
    let release: (() => void) | undefined
    const entered = new Promise<void>((resolve) => (release = resolve))
    const session = new ApiAgentSession({
      model: 'test-model',
      secrets: [secret],
      transport: async function* ({ signal }) {
        release?.()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
        throw new Error(secret)
      },
    })
    session.on('event', (event) => events.push(event))
    session.on('log', (line) => logs.push(line))
    const thread = session.startThread('C:\\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Wait')
    await entered
    await session.interrupt(thread.id)

    expect(events).toContainEqual({ type: 'turn.completed', turnId, status: 'interrupted' })
    expect(JSON.stringify({ events, logs })).not.toContain(secret)
  })

  it('closes partial streamed items before a failed turn', async () => {
    const events: DomainEvent[] = []
    const session = new ApiAgentSession({
      model: 'test-model',
      transport: async function* () {
        yield { type: 'text', delta: 'partial answer' }
        yield { type: 'reasoning', delta: 'partial thought' }
        throw new Error('transport failed')
      },
    })
    session.on('event', (event) => events.push(event))
    const thread = session.startThread('C:\\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Go')
    await session.waitForTurn(turnId)

    const terminal = events.findIndex((event) => event.type === 'turn.completed')
    const completed = events.filter((event) => event.type === 'item.completed')
    expect(completed).toHaveLength(2)
    expect(completed.every((event) => event.item.status === 'failed')).toBe(true)
    expect(events.lastIndexOf(completed[1]!)).toBeLessThan(terminal)
  })

  it('fails safely when a transport exceeds the tool-call bound', async () => {
    const events: unknown[] = []
    const session = new ApiAgentSession({
      model: 'test-model',
      maxToolCalls: 1,
      transport: async function* () {
        yield { type: 'tool_call', call: { id: crypto.randomUUID(), name: 'loop', input: {} } }
        yield { type: 'finish', reason: 'tool_calls' }
      },
    })
    session.on('event', (event) => events.push(event))
    const thread = session.startThread('C:\\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Loop')
    await session.waitForTurn(turnId)

    expect(events).toContainEqual({ type: 'turn.completed', turnId, status: 'failed' })
  })
})

describe('overnight regression pins', () => {
  it('synthesizes error tool results for calls orphaned by a failing turn', async () => {
    // Without this, the persisted history carries tool_use with no
    // tool_result, and every later Anthropic request 400s - a bricked thread.
    const session = new ApiAgentSession({
      model: 'test-model',
      // Budget of one: the second call trips the limit before running, which
      // is exactly the state that used to persist an unanswered tool_use.
      maxToolCalls: 1,
      tools: [
        {
          name: 'boom',
          description: 'never allowed to run',
          inputSchema: {},
          run: async () => ({ content: 'unused', isError: false }),
        },
      ],
      transport: transport(
        { type: 'tool_call', call: { id: 'call-1', name: 'boom', input: {} } },
        { type: 'tool_call', call: { id: 'call-2', name: 'boom', input: {} } },
        { type: 'finish', reason: 'tool_calls' },
      ),
    })
    const thread = session.startThread('C:\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Go')
    await session.waitForTurn(turnId)

    const toolResults = session.snapshot().messages.filter((message) => message.role === 'tool')
    expect(toolResults).toContainEqual(
      expect.objectContaining({
        toolCallId: 'call-2',
        isError: true,
        content: 'Tool execution was interrupted.',
      }),
    )
  })

  it('holds back streamed chunks so a secret split across deltas never leaks', async () => {
    const secret = 'sk-super-secret-key'
    const session = new ApiAgentSession({
      model: 'test-model',
      secrets: [secret],
      transport: transport(
        { type: 'text', delta: `prefix ${secret.slice(0, 8)}` },
        { type: 'text', delta: `${secret.slice(8)} suffix` },
        { type: 'finish', reason: 'stop' },
      ),
    })
    const deltas: string[] = []
    session.on('event', (event) => {
      if (event.type === 'item.delta') deltas.push(event.textDelta)
    })
    const thread = session.startThread('C:\repo', 'connection-1')
    const turnId = await session.sendTurn(thread.id, 'Hi')
    await session.waitForTurn(turnId)

    expect(deltas.join('')).not.toContain(secret)
    const assistant = session.snapshot().messages.find((message) => message.role === 'assistant')
    expect(assistant?.content).toContain('[REDACTED]')
    expect(assistant?.content).not.toContain(secret)
    // The rolling-window redaction must not eat the tail: everything after
    // the secret still arrives, in the deltas and in the final message.
    expect(assistant?.content).toBe('prefix [REDACTED] suffix')
    expect(deltas.join('')).toBe('prefix [REDACTED] suffix')
  })
})
