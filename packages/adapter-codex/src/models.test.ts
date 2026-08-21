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
  it('keeps the complete known Codex roster selectable when model/list omits rows', async () => {
    const models = await listedModels()
    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ])
    expect(models.at(-1)).toMatchObject({
      displayName: 'GPT-5.3-Codex-Spark',
      defaultReasoningEffort: 'high',
    })
  })

  it('does not duplicate Spark when Codex lists it again', async () => {
    const models = await listedModels([
      providerModel,
      { ...providerModel, id: 'gpt-5.3-codex-spark', displayName: 'Spark', isDefault: false },
    ])

    expect(models.filter((model) => model.id === 'gpt-5.3-codex-spark')).toHaveLength(1)
  })

  it('removes the superseded GPT-5.2 row from the catalog', async () => {
    const models = await listedModels([
      providerModel,
      { ...providerModel, id: 'gpt-5.2', displayName: 'GPT-5.2', isDefault: false },
    ])

    expect(models.some((model) => model.id === 'gpt-5.2')).toBe(false)
  })
})
