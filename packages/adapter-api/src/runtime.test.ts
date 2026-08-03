import { describe, expect, it } from 'vitest'
import { ApiAgentSession, type ApiStreamEvent, type ApiTransport } from './runtime.js'

function transport(...events: ApiStreamEvent[]): ApiTransport {
  return async function* () {
    yield* events
  }
}

describe('ApiAgentSession', () => {
  it('streams a provider-neutral turn and preserves resumable history', async () => {
    const session = new ApiAgentSession({
      model: 'test-model',
      transport: transport(
        { type: 'text', delta: 'Hello ' },
        { type: 'text', delta: 'world' },
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
      { role: 'assistant', content: 'Hello world', toolCalls: [] },
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

  it('runs approved tools through the injected Harness executor', async () => {
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
