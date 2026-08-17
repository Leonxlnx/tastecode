import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

function promptAdapter() {
  const rpc = new FakeCodexRpc((method) => {
    if (method === 'thread/start') {
      return { thread: { id: 'thread-1' }, model: 'gpt-5.6' }
    }
    if (method === 'thread/resume') {
      return {
        thread: { id: 'thread-1', createdAt: 1_700_000_000 },
        model: 'gpt-5.6',
      }
    }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    return {}
  })
  let spawnArgs: string[] = []
  const adapter = new CodexAdapter({
    connect: (launch) => {
      spawnArgs = launch.args
      return rpc
    },
  })
  return { adapter, rpc, spawnArgs: () => spawnArgs }
}

describe('Codex prompt transport', () => {
  it('keeps product-internal work out of provider history when requested', async () => {
    const { adapter, rpc } = promptAdapter()
    await adapter.start()
    await adapter.startThread('C:\\repo', { ephemeral: true })

    expect(rpc.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      ephemeral: true,
    })
    adapter.dispose()
  })

  it('keeps long unicode and multiline prompts in structured JSON-RPC input', async () => {
    const { adapter, rpc, spawnArgs } = promptAdapter()
    const text = ` Grüße 🧪\n${'x'.repeat(40_000)}`
    await adapter.start()
    const thread = await adapter.startThread('C:\\repo')
    expect(rpc.calls.find((call) => call.method === 'thread/start')?.timeoutMs).toBe(30_000)

    await adapter.sendTurn(thread.id, text)

    const turn = rpc.calls.find((call) => call.method === 'turn/start')
    expect(turn?.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text, text_elements: [] }],
    })
    expect(spawnArgs().join(' ')).not.toContain(text)
    adapter.dispose()
  })

  it('sends the active turn precondition when steering or interrupting', async () => {
    const { adapter, rpc } = promptAdapter()
    await adapter.start()
    const thread = await adapter.startThread('C:\\repo')
    rpc.emitNotification('turn/started', {
      threadId: thread.id,
      turn: { id: 'turn-live' },
    })

    await adapter.steer(thread.id, 'Change direction')
    await adapter.interrupt(thread.id)

    expect(rpc.calls.find((call) => call.method === 'turn/steer')?.params).toMatchObject({
      threadId: thread.id,
      expectedTurnId: 'turn-live',
    })
    expect(rpc.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({
      threadId: thread.id,
      turnId: 'turn-live',
    })
    adapter.dispose()
  })

  it('updates a live thread with the selected access level', async () => {
    const { adapter, rpc } = promptAdapter()
    await adapter.start()
    await adapter.startThread('C:\\repo', { approval: 'auto-review' })

    await adapter.setApproval('full')

    expect(rpc.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-1',
      cwd: 'C:\\repo',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user',
    })
    adapter.dispose()
  })
})
