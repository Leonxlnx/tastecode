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
  it("orders the current lineup by Codex's own priority without inventing missing ones", async () => {
    // The rows codex-cli 0.154 lists, shuffled; Astra is its default.
    const models = await listedModels([
      { ...providerModel, id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', isDefault: false },
      { ...providerModel, id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: false },
      { ...providerModel, isDefault: false },
      { ...providerModel, id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true },
    ])
    expect(models.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ])
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-6-astra')
  })

  it('keeps a newly advertised model after the known lineup and before the legacy row', async () => {
    const models = await listedModels([
      { ...providerModel, id: 'gpt-6-nova', displayName: 'GPT-6-Nova', isDefault: false },
      providerModel,
      { ...providerModel, id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: false },
    ])
    expect(models.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-6-nova',
      'gpt-5.5',
    ])
  })

  it('keeps the hidden legacy GPT-5.5 selectable and drops models Codex no longer ships', async () => {
    const models = await listedModels()
    // codex-cli 0.154 still runs gpt-5.5 but hides it from model/list; it no
    // longer has gpt-5.4, gpt-5.4-mini or gpt-5.3-codex-spark at all.
    expect(models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5'])
    expect(models.at(-1)).toEqual({
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Legacy coding model.',
      isDefault: false,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    })
  })

  it('lets a live GPT-5.5 row win over the legacy fallback without duplicating it', async () => {
    const models = await listedModels([
      providerModel,
      { ...providerModel, id: 'gpt-5.5', displayName: 'GPT-5.5 live', isDefault: false },
    ])

    expect(models.filter((model) => model.id === 'gpt-5.5')).toEqual([
      expect.objectContaining({ displayName: 'GPT-5.5 live' }),
    ])
  })

  it('removes the superseded GPT-5.2 row from the catalog', async () => {
    const models = await listedModels([
      providerModel,
      { ...providerModel, id: 'gpt-5.2', displayName: 'GPT-5.2', isDefault: false },
    ])

    expect(models.some((model) => model.id === 'gpt-5.2')).toBe(false)
  })
})
