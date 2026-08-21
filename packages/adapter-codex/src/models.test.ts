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

const providerModel = {
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  description: 'Frontier coding model.',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  defaultReasoningEffort: 'high',
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault: true,
}

async function listedModels(data = [providerModel]) {
  proc.rpc = new FakeCodexRpc((method) =>
    method === 'model/list' ? { data, nextCursor: null } : {},
  )
  const adapter = new CodexAdapter()
  await adapter.start()
  const models = await adapter.listModels()
  adapter.dispose()
  return models
}

describe('Codex models', () => {
  it('keeps Spark selectable when Codex omits it from model/list', async () => {
    expect(await listedModels()).toContainEqual({
      id: 'gpt-5.3-codex-spark',
      displayName: 'GPT-5.3-Codex-Spark',
      description: 'Ultra-fast coding model.',
      isDefault: false,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'high',
      serviceTiers: [],
    })
  })

  it('does not duplicate Spark when Codex lists it again', async () => {
    const models = await listedModels([
      providerModel,
      { ...providerModel, id: 'gpt-5.3-codex-spark', displayName: 'Spark', isDefault: false },
    ])

    expect(models.filter((model) => model.id === 'gpt-5.3-codex-spark')).toHaveLength(1)
  })
})
