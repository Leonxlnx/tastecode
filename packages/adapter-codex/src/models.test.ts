import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'

/**
 * The `model/list` result codex-cli 0.163.0's app-server answered on
 * 2026-10-17 for a signed-in ChatGPT account, captured verbatim with
 * `includeHidden: true`. The adapter asks without it and gets the same rows
 * minus the two hidden ones (`gpt-reserve`, `codex-auto-review`).
 * `codex debug models` shows the same refreshed catalog; only its `--bundled`
 * catalog still lists gpt-5.5 and `upgrade` targets.
 */
const modelList163 = JSON.parse(
  readFileSync(new URL('./fixtures/model-list-codex-0.163.json', import.meta.url), 'utf8'),
) as { data: (typeof providerModel)[] }

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
  it('lists every model codex-cli 0.163 offers, newest of each tier first', async () => {
    const models = await listedModels(modelList163.data)
    expect(models.map((model) => model.id)).toEqual([
      // The newest generation of each tier, in tier order.
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-5.6-terra',
      'gpt-6-luna',
      // Older generations, newest first.
      'gpt-6-sol',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ])
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-6.1-sol')
  })

  it('places a new generation of a tier without being told about it', async () => {
    const models = await listedModels([
      ...modelList163.data,
      { ...providerModel, id: 'gpt-7-terra', displayName: 'GPT-7-Terra', isDefault: false },
      { ...providerModel, id: 'gpt-7-nova', displayName: 'GPT-7-Nova', isDefault: false },
    ])
    expect(models.map((model) => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-7-terra',
      'gpt-6-luna',
      'gpt-6-sol',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      // A tier Codex adds later follows the known ones in Codex's order.
      'gpt-7-nova',
    ])
  })

  it('orders the codex-cli 0.154 lineup by tier without inventing missing ones', async () => {
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
    ])
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-6-astra')
  })

  it('keeps a newly advertised model after the known lineup', async () => {
    const models = await listedModels([
      { ...providerModel, id: 'gpt-6-nova', displayName: 'GPT-6-Nova', isDefault: false },
      providerModel,
      { ...providerModel, id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: false },
    ])
    expect(models.map((model) => model.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-6-nova'])
  })

  it('offers only the models Codex lists, with nothing added', async () => {
    expect((await listedModels()).map((model) => model.id)).toEqual(['gpt-5.6-sol'])
    // The refreshed 0.163 catalog has no gpt-5.5 and no row it hides is offered.
    const live = await listedModels(modelList163.data)
    expect(live.some((model) => model.id === 'gpt-5.5')).toBe(false)
    expect(live.some((model) => model.id === 'gpt-reserve')).toBe(false)
    expect(live.some((model) => model.id === 'codex-auto-review')).toBe(false)
  })

  it('still offers GPT-5.5 when Codex lists it from its bundled catalog', async () => {
    const models = await listedModels([
      providerModel,
      { ...providerModel, id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: false },
    ])

    expect(models.filter((model) => model.id === 'gpt-5.5')).toEqual([
      expect.objectContaining({ displayName: 'GPT-5.5' }),
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
