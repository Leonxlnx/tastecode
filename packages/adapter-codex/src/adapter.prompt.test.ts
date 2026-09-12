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

  it.each(['ask', 'auto', 'auto-review', 'full'] as const)(
    'applies %s to the next turn of an already-loaded chat',
    async (mode) => {
      const { adapter, rpc } = promptAdapter()
      await adapter.start()
      const thread = await adapter.startThread('C:\\repo', { approval: 'full' })
      rpc.emitNotification('turn/started', {
        threadId: thread.id,
        turn: { id: 'turn-live' },
      })

      await adapter.setApproval(mode)

      // A settings change must not resume the loaded thread, start an empty
      // turn, or interrupt work already in progress.
      expect(rpc.calls.map((call) => call.method)).toEqual(['initialize', 'thread/start'])
      await adapter.sendTurn(thread.id, 'Continue')
      await adapter.sendTurn(thread.id, 'And continue again')
      const turns = rpc.calls.filter((call) => call.method === 'turn/start')
      expect(turns).toHaveLength(2)
      for (const turn of turns) {
        expect(turn.params).toMatchObject({
          approvalPolicy: mode === 'ask' ? 'untrusted' : mode === 'full' ? 'never' : 'on-request',
          approvalsReviewer: mode === 'auto-review' ? 'auto_review' : 'user',
          sandboxPolicy:
            mode === 'full'
              ? { type: 'dangerFullAccess' }
              : mode === 'ask'
                ? { type: 'readOnly', networkAccess: false }
                : {
                    type: 'workspaceWrite',
                    writableRoots: [],
                    networkAccess: false,
                    excludeTmpdirEnvVar: false,
                    excludeSlashTmp: false,
                  },
        })
      }
      adapter.dispose()
    },
  )

  it('uses the last selection when switching back from auto-review to ask first', async () => {
    const { adapter, rpc } = promptAdapter()
    await adapter.start()
    const thread = await adapter.resumeThread('thread-1', 'C:\\repo', { approval: 'full' })
    await adapter.setApproval('auto-review')
    await adapter.setApproval('ask')
    await adapter.sendTurn(thread.id, 'Continue')
    expect(rpc.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    adapter.dispose()
  })
})
