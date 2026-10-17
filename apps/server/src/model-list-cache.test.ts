import type { Model, ProviderId } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ModelListCache, type ModelListCacheOptions } from './model-list-cache.js'

function model(id: string): Model {
  return { id, displayName: id, isDefault: false, reasoningEfforts: [], serviceTiers: [] }
}

type Pending = {
  provider: ProviderId
  agent: string | undefined
  resolve: (models: Model[]) => void
  reject: (error: Error) => void
}

function setup(options: Partial<ModelListCacheOptions> = {}) {
  let now = 1_000_000
  const reads: Pending[] = []
  const list = vi.fn(
    (provider: ProviderId, agent: string | undefined) =>
      new Promise<Model[]>((resolve, reject) => reads.push({ provider, agent, resolve, reject })),
  )
  const onChanged = vi.fn()
  const onLog = vi.fn()
  const cache = new ModelListCache({ list, onChanged, onLog, now: () => now, ...options })
  return {
    cache,
    list,
    reads,
    onChanged,
    onLog,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('model list cache', () => {
  it('shares one read between concurrent requests and answers later ones from it', async () => {
    const { cache, list, reads } = setup()
    const first = cache.list('codex')
    const second = cache.list('codex')
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
    reads[0]!.resolve([model('gpt-6.1-sol')])
    await expect(Promise.all([first, second])).resolves.toEqual([
      [model('gpt-6.1-sol')],
      [model('gpt-6.1-sol')],
    ])

    await expect(cache.list('codex')).resolves.toEqual([model('gpt-6.1-sol')])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps sources apart by provider and agent', async () => {
    const { cache, list, reads } = setup()
    void cache.list('codex')
    void cache.list('codex', 'work-codex')
    void cache.list('acp', 'kimi')
    await flush()
    expect(list.mock.calls).toEqual([
      ['codex', undefined, { refresh: false }],
      ['codex', 'work-codex', { refresh: false }],
      ['acp', 'kimi', { refresh: false }],
    ])
    expect(reads).toHaveLength(3)
  })

  it('answers an older list at once and replaces it in the background', async () => {
    const { cache, list, reads, onChanged, advance } = setup()
    const first = cache.list('claude-code')
    await flush()
    reads[0]!.resolve([model('opus')])
    await first

    advance(10 * 60_000)
    await expect(cache.list('claude-code')).resolves.toEqual([model('opus')])
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    // The provider learns the list survives a failed read, so it need not guess.
    expect(list.mock.calls.map((call) => call[2])).toEqual([{ refresh: false }, { refresh: true }])
    // A request during the refresh answers from the same list without another read.
    await expect(cache.list('claude-code')).resolves.toEqual([model('opus')])
    expect(list).toHaveBeenCalledTimes(2)

    reads[1]!.resolve([model('opus'), model('claude-fable-5-2')])
    await flush()
    expect(onChanged).toHaveBeenCalledExactlyOnceWith('claude-code', undefined)
    await expect(cache.list('claude-code')).resolves.toEqual([
      model('opus'),
      model('claude-fable-5-2'),
    ])
  })

  it('stays quiet when a refresh finds the same list', async () => {
    const { cache, reads, onChanged, advance } = setup()
    const first = cache.list('grok')
    await flush()
    reads[0]!.resolve([model('grok-4.7')])
    await first
    advance(11 * 60_000)
    await cache.list('grok')
    await flush()
    reads[1]!.resolve([model('grok-4.7')])
    await flush()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('never stores a failure and reads again when nothing usable is cached', async () => {
    const { cache, list, reads } = setup()
    const first = cache.list('cursor')
    await flush()
    reads[0]!.reject(new Error('CLI did not respond within the time limit'))
    await expect(first).rejects.toThrow('CLI did not respond within the time limit')

    const second = cache.list('cursor')
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    reads[1]!.resolve([model('composer-2.5')])
    await expect(second).resolves.toEqual([model('composer-2.5')])
  })

  it('keeps the last good list through a failed refresh for up to a day', async () => {
    const { cache, list, reads, onLog, advance } = setup()
    const first = cache.list('cursor')
    await flush()
    reads[0]!.resolve([model('composer-2.5')])
    await first

    advance(20 * 60_000)
    await expect(cache.list('cursor')).resolves.toEqual([model('composer-2.5')])
    await flush()
    reads[1]!.reject(new Error('timed out'))
    await flush()
    expect(onLog).toHaveBeenCalledWith(
      'Kept the last cursor model list; refreshing it failed: timed out',
    )
    // The failure is spaced out instead of retried on every request.
    await expect(cache.list('cursor')).resolves.toEqual([model('composer-2.5')])
    expect(list).toHaveBeenCalledTimes(2)
    advance(60_000)
    await cache.list('cursor')
    await flush()
    expect(list).toHaveBeenCalledTimes(3)
    reads[2]!.reject(new Error('timed out'))
    await flush()

    // Past a day the old list no longer answers on its own.
    advance(24 * 60 * 60_000)
    const late = cache.list('cursor')
    await flush()
    reads[3]!.reject(new Error('timed out'))
    await expect(late).rejects.toThrow('timed out')
  })

  it('refreshes an invalidated list on the next request and ignores a read it overtook', async () => {
    const { cache, list, reads, onChanged } = setup()
    const first = cache.list('codex')
    await flush()
    reads[0]!.resolve([model('gpt-6-astra')])
    await first

    // A read for the old account is still running when the account changes.
    cache.invalidate('codex')
    void cache.list('codex')
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    cache.invalidate('codex')
    await expect(cache.list('codex')).resolves.toEqual([model('gpt-6-astra')])
    await flush()
    expect(list).toHaveBeenCalledTimes(3)

    reads[1]!.resolve([model('stale-account-model')])
    await flush()
    reads[2]!.resolve([model('gpt-6.1-sol')])
    await flush()
    expect(onChanged).toHaveBeenCalledExactlyOnceWith('codex', undefined)
    await expect(cache.list('codex')).resolves.toEqual([model('gpt-6.1-sol')])
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('invalidates one agent or every source of a provider', async () => {
    const { cache, list, reads } = setup()
    const reads0 = [cache.list('codex'), cache.list('codex', 'work'), cache.list('grok')]
    await flush()
    for (const read of reads) read.resolve([model('row')])
    await Promise.all(reads0)

    cache.invalidate('codex', 'work')
    await Promise.all([cache.list('codex'), cache.list('codex', 'work'), cache.list('grok')])
    await flush()
    expect(list).toHaveBeenCalledTimes(4)
    expect(list).toHaveBeenLastCalledWith('codex', 'work', { refresh: true })

    cache.invalidate('codex')
    await Promise.all([cache.list('codex'), cache.list('codex', 'work'), cache.list('grok')])
    await flush()
    // The read `work` had in flight predates this invalidation, so it reads again.
    expect(list.mock.calls.slice(4)).toEqual([
      ['codex', undefined, { refresh: true }],
      ['codex', 'work', { refresh: true }],
    ])
  })

  it('forgets a removed agent so its next request waits for a fresh read', async () => {
    const { cache, list, reads } = setup()
    const first = cache.list('opencode', 'work-opencode')
    await flush()
    reads[0]!.resolve([model('old-row')])
    await first

    cache.forgetAgent('work-opencode')
    const next = cache.list('opencode', 'work-opencode')
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    reads[1]!.resolve([model('new-row')])
    await expect(next).resolves.toEqual([model('new-row')])
  })
})

describe('model lists across launches', () => {
  function memory(initial?: string) {
    const saved = { value: initial }
    return {
      saved,
      store: {
        read: () => saved.value,
        write: (value: string) => {
          saved.value = value
        },
      },
    }
  }
  const snapshot = (lists: unknown[]) => JSON.stringify({ version: 1, lists })

  it('answers from the last launch at once and reads the source again after launch work', async () => {
    const launchedAt = Date.now()
    const { saved, store } = memory(
      snapshot([
        { provider: 'codex', listedAt: launchedAt - 3_600_000, models: [model('gpt-6-astra')] },
      ]),
    )
    const { cache, list, reads, onChanged } = setup({
      snapshot: store,
      restoredRefreshDelayMs: 200,
      now: () => Date.now(),
    })

    await expect(cache.list('codex')).resolves.toEqual([model('gpt-6-astra')])
    await expect(cache.list('codex')).resolves.toEqual([model('gpt-6-astra')])
    await flush()
    expect(list).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    expect(Date.now() - launchedAt).toBeGreaterThanOrEqual(190)
    // A failed read keeps the last launch's list, so the provider must not guess.
    expect(list).toHaveBeenCalledWith('codex', undefined, { refresh: true })

    reads[0]!.resolve([model('gpt-6.1-sol'), model('gpt-6-astra')])
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledExactlyOnceWith('codex', undefined))
    const saved1 = JSON.parse(saved.value!) as { lists: { listedAt: number }[] }
    expect(saved1).toEqual({
      version: 1,
      lists: [
        {
          provider: 'codex',
          listedAt: expect.any(Number),
          models: [model('gpt-6.1-sol'), model('gpt-6-astra')],
        },
      ],
    })
    expect(saved1.lists[0]!.listedAt).toBeGreaterThanOrEqual(launchedAt + 190)
    // Read in this launch, it is fresh again.
    await cache.list('codex')
    expect(list).toHaveBeenCalledOnce()
  })
  it('refreshes a list from the last launch at once when launch work is over', async () => {
    const { store } = memory(
      snapshot([{ provider: 'grok', listedAt: 999_000, models: [model('grok-4.7')] }]),
    )
    const { cache, list } = setup({ snapshot: store, restoredRefreshDelayMs: 0 })
    await expect(cache.list('grok')).resolves.toEqual([model('grok-4.7')])
    await flush()
    expect(list).toHaveBeenCalledOnce()
  })

  it('does not wait for launch work once the list is known to be out of date', async () => {
    const { store } = memory(
      snapshot([{ provider: 'claude-code', listedAt: 999_000, models: [model('opus')] }]),
    )
    const { cache, list } = setup({ snapshot: store, restoredRefreshDelayMs: 60_000 })
    await cache.list('claude-code')
    await flush()
    expect(list).not.toHaveBeenCalled()
    cache.invalidate('claude-code')
    await expect(cache.list('claude-code')).resolves.toEqual([model('opus')])
    await flush()
    expect(list).toHaveBeenCalledOnce()
  })

  it('leaves out lists older than a day, lists it cannot read and other formats', async () => {
    const day = 24 * 60 * 60_000
    const { store } = memory(
      snapshot([
        { provider: 'codex', listedAt: 1_000_000 - day, models: [model('old')] },
        { provider: 'nope', listedAt: 999_000, models: [model('unknown-provider')] },
        { provider: 'grok', listedAt: 999_000, models: [{ id: 1 }] },
        { provider: 'acp', agent: 'kimi', listedAt: 999_000, models: [model('kimi-k3')] },
      ]),
    )
    const { cache, list } = setup({ snapshot: store, restoredRefreshDelayMs: 60_000 })
    await expect(cache.list('acp', 'kimi')).resolves.toEqual([model('kimi-k3')])
    void cache.list('codex')
    void cache.list('grok')
    await flush()
    expect(list.mock.calls).toEqual([
      ['codex', undefined, { refresh: false }],
      ['grok', undefined, { refresh: false }],
    ])

    for (const raw of ['{', JSON.stringify({ version: 2, lists: [] }), undefined]) {
      const other = setup({ snapshot: memory(raw).store })
      void other.cache.list('codex')
      await flush()
      expect(other.list).toHaveBeenCalledOnce()
    }
  })

  it('keeps a very large list for this launch only and forgets a removed agent', async () => {
    const { saved, store } = memory()
    const { cache, reads } = setup({ snapshot: store })
    const huge = Array.from({ length: 2_001 }, (_, index) => model(`row-${index}`))
    const reading = [cache.list('opencode'), cache.list('opencode', 'work')]
    await flush()
    reads[0]!.resolve(huge)
    reads[1]!.resolve([model('work-row')])
    await Promise.all(reading)
    expect(JSON.parse(saved.value!).lists).toEqual([
      { provider: 'opencode', agent: 'work', listedAt: 1_000_000, models: [model('work-row')] },
    ])

    cache.forgetAgent('work')
    expect(JSON.parse(saved.value!).lists).toEqual([])
  })
})
