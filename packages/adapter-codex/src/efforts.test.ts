import { readFileSync } from 'node:fs'
import type { JsonRpcValue } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

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

/** The `model/list` result codex-cli 0.154.0's app-server answered, captured verbatim. */
const modelList = JSON.parse(
  readFileSync(new URL('./fixtures/model-list-codex-0.154.json', import.meta.url), 'utf8'),
) as JsonRpcValue

function codex() {
  const rpc = new FakeCodexRpc((method) => {
    if (method === 'model/list') return modelList
    if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-6-astra' }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    return {}
  })
  proc.rpc = rpc
  return { adapter: new CodexAdapter(), rpc }
}

describe('Codex reasoning efforts', () => {
  it("offers Max and Ultra exactly where Codex's catalog lists them", async () => {
    const { adapter } = codex()
    await adapter.start()
    const models = await adapter.listModels()
    adapter.dispose()
    const efforts = (id: string) => models.find((model) => model.id === id)?.reasoningEfforts

    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(efforts(id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    }
    expect(efforts('gpt-5.6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(models.find((model) => model.id === 'gpt-6-astra')).toMatchObject({
      defaultReasoningEffort: 'medium',
    })
  })

  it('sends Ultra to Codex unchanged on thread start and on each turn', async () => {
    const { adapter, rpc } = codex()
    try {
      await adapter.start()
      const thread = await adapter.startThread('C:\\repo', {
        model: 'gpt-6-astra',
        effort: 'ultra',
      })
      await adapter.sendTurn(thread.id, 'Reply OK', [], { effort: 'ultra' })

      expect(rpc.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
        config: { model_reasoning_effort: 'ultra' },
      })
      expect(rpc.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
        effort: 'ultra',
      })
    } finally {
      adapter.dispose()
    }
  })
})
