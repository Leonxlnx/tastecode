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

    const resumed = new ApiAgentSession({ model: 'test-model', transport: transport() })
    expect(resumed.resumeThread(session.snapshot())).toEqual(thread)
  })
})
