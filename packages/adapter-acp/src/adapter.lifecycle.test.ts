import { describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@harness/contracts'

/**
 * Approval lifecycle under a stubbed transport: the agent process is faked so
 * these can drive session/request_permission and prompt completion directly.
 * They pin the overnight fixes — abandoned responders answered, and auto mode
 * never waving through mutations.
 */

type ServerRequestHandler = (
  method: string,
  params: unknown,
  respond: (result: unknown) => void,
) => void

const fake = vi.hoisted(() => ({
  instance: undefined as
    | {
        onServerRequest: ServerRequestHandler
        resolvePrompt: (result: unknown) => void
      }
    | undefined,
}))

vi.mock('@harness/proc', () => ({
  spawnCli: vi.fn(() => ({ pid: 1 })),
  killTree: vi.fn(),
  StdioJsonRpc: class {
    #onServerRequest: ServerRequestHandler = (_m, _p, respond) => respond(null)

    constructor() {
      fake.instance = {
        onServerRequest: (method, params, respond) =>
          this.#onServerRequest(method, params, respond),
        resolvePrompt: () => {},
      }
    }

    onStderr(): void {}
    onNotification(): void {}
    onServerRequest(handler: ServerRequestHandler): void {
      this.#onServerRequest = handler
    }

    request(method: string): Promise<unknown> {
      if (method === 'initialize') {
        return Promise.resolve({
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
        })
      }
      if (method === 'session/new') return Promise.resolve({ sessionId: 'sess-1' })
      if (method === 'session/prompt') {
        return new Promise((resolve) => {
          fake.instance!.resolvePrompt = resolve
        })
      }
      return Promise.resolve({})
    }

    notify(): void {}
    dispose(): void {}
  },
}))

const { AcpAdapter } = await import('./adapter.js')

async function startedAdapter(approval: 'ask' | 'auto') {
  const adapter = new AcpAdapter('gemini')
  const events: DomainEvent[] = []
  adapter.on('event', (event) => events.push(event))
  await adapter.startThread('C:\\repo', { approval })
  const threadId = 'acp-gemini-sess-1'
  const turnId = await adapter.sendTurn(threadId, 'go')
  return { adapter, events, turnId }
}

function requestPermission(kind: string): Promise<unknown> {
  return new Promise((resolve) => {
    fake.instance!.onServerRequest(
      'session/request_permission',
      {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'do something', kind },
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
        ],
      },
      resolve,
    )
  })
}

describe('ACP approval lifecycle', () => {
  it('does not start a turn when attachment preparation fails', async () => {
    const adapter = new AcpAdapter('gemini')
    const events: DomainEvent[] = []
    adapter.on('event', (event) => events.push(event))
    await adapter.startThread('C:\\repo')

    await expect(
      adapter.sendTurn('acp-gemini-sess-1', 'review', ['preview.png']),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(events).toEqual([])
  })

  it('answers an abandoned approval with cancelled when the turn ends', async () => {
    const { events, turnId } = await startedAdapter('ask')
    const answered = requestPermission('execute')

    // The turn ends while the approval is still open.
    fake.instance!.resolvePrompt({ stopReason: 'end_turn' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The agent hears "cancelled" — not silence that blocks it forever —
    // and the UI hears resolved.
    await expect(answered).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'approval.resolved' }))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'turn.completed', turnId, status: 'completed' }),
    )
  })

  it('auto mode only waves through reads — mutations stay questions', async () => {
    const { events } = await startedAdapter('auto')

    // Non-mutating: auto-answered, no card.
    const read = requestPermission('read')
    await expect(read).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })

    // Mutating kinds surface to the user instead of self-approving. ACP has
    // no sandbox behind these.
    for (const kind of ['execute', 'edit', 'delete', 'move', 'fetch']) {
      void requestPermission(kind)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const asked = events.filter((event) => event.type === 'approval.requested')
    expect(asked).toHaveLength(5)
  })
})
