import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

const proc = vi.hoisted(() => ({
  rpc: undefined as FakeCodexRpc | undefined,
  spawnArgs: [] as string[],
}))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn((_command: string, args: string[]) => {
    proc.spawnArgs = args
    return { pid: 1 }
  }),
  StdioJsonRpc: class {
    constructor() {
      if (!proc.rpc) throw new Error('fake Codex RPC was not installed')
      return proc.rpc
    }
  },
}))

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
  proc.rpc = rpc
  proc.spawnArgs = []
  return { adapter: new CodexAdapter(), rpc, spawnArgs: () => proc.spawnArgs }
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
