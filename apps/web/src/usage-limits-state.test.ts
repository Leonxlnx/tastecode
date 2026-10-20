import type { ParamsOf, ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { pollUsageLimits, UsageLimitsController } from './usage-limits-state.js'

type Summary = ResultOf<'usage.summary'>

const summary = (provider: ProviderId): Summary => ({
  session: emptyUsage(),
  today: emptyUsage(),
  limits: [],
  limitSource: { provider, status: 'unavailable' },
})

const emptyUsage = () => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
})

describe('UsageLimitsController', () => {
  it('keeps every selected provider as a separate authoritative source', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const controller = new UsageLimitsController(load)

    controller.select([{ provider: 'codex' }, { provider: 'claude-code' }])
    expect(controller.snapshot().map((state) => [state.provider, state.status])).toEqual([
      ['codex', 'loading'],
      ['claude-code', 'loading'],
    ])
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )

    expect(controller.snapshot().map((state) => [state.provider, state.status])).toEqual([
      ['codex', 'ready'],
      ['claude-code', 'ready'],
    ])
    // Nothing shows the limits yet, so the requests are for a passive figure.
    expect(load).toHaveBeenCalledWith({ provider: 'codex', intent: 'background' })
    expect(load).toHaveBeenCalledWith({ provider: 'claude-code', intent: 'background' })
  })

  it('reads every source afresh when a view opens, and says so while it is open', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }, { provider: 'claude-code' }])
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )
    load.mockClear()

    // StrictMode closes and reopens a view in the same task; that asks once.
    controller.show()()
    const release = controller.show()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load).toHaveBeenCalledWith({ provider: 'codex', intent: 'refresh' })
    expect(load).toHaveBeenCalledWith({ provider: 'claude-code', intent: 'refresh' })
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )

    // A second view that opens beside it asks nothing new.
    const second = controller.show()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    release()
    release()
    controller.refresh('codex')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3))
    expect(load).toHaveBeenLastCalledWith({ provider: 'codex', intent: 'visible' })
    second()
    controller.refresh('codex')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4))
    expect(load).toHaveBeenLastCalledWith({ provider: 'codex', intent: 'background' })
    controller.refresh('claude-code', 'retry')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(5))
    expect(load).toHaveBeenLastCalledWith({ provider: 'claude-code', intent: 'retry' })
  })

  it('preserves same-source values on failure and retries only that source', async () => {
    let failClaude = false
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) => {
      const provider = 'provider' in params ? params.provider : 'codex'
      if (provider === 'claude-code' && failClaude) throw new Error('Temporary failure')
      return summary(provider === 'claude-code' ? 'claude-code' : 'codex')
    })
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }, { provider: 'claude-code' }])
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )

    failClaude = true
    controller.refresh('claude-code')
    await vi.waitFor(() =>
      expect(controller.snapshot().find((state) => state.provider === 'claude-code')?.status).toBe(
        'error',
      ),
    )

    const [codex, claude] = controller.snapshot()
    expect(codex?.status).toBe('ready')
    expect(claude).toMatchObject({
      provider: 'claude-code',
      status: 'error',
      message: 'Temporary failure',
      summary: summary('claude-code'),
    })
    expect(
      load.mock.calls.filter(([params]) => 'provider' in params && params.provider === 'codex'),
    ).toHaveLength(1)
    expect(
      load.mock.calls.filter(
        ([params]) => 'provider' in params && params.provider === 'claude-code',
      ),
    ).toHaveLength(2)
  })

  it('drops removed sources and ignores their late responses', async () => {
    let resolveClaude: ((value: Summary) => void) | undefined
    const load = vi.fn((params: ParamsOf<'usage.summary'>) => {
      if ('provider' in params && params.provider === 'claude-code') {
        return new Promise<Summary>((resolve) => {
          resolveClaude = resolve
        })
      }
      return Promise.resolve(summary('codex'))
    })
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }, { provider: 'claude-code' }])
    controller.select([{ provider: 'codex' }])
    resolveClaude?.(summary('claude-code'))
    await Promise.resolve()

    expect(controller.snapshot().map((state) => state.provider)).toEqual(['codex'])
  })

  it('routes a pushed snapshot to its source without a request', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }, { provider: 'claude-code' }])
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )
    load.mockClear()

    const pushed: ProviderLimitSource = {
      provider: 'claude-code',
      status: 'ready',
      limits: [{ id: 'five_hour', label: '5h', usedPercent: 30 }],
    }
    controller.applySource(pushed)
    controller.applySource({ provider: 'grok', status: 'unavailable' })

    expect(controller.snapshot().map((state) => state.summary?.limitSource)).toEqual([
      { provider: 'codex', status: 'unavailable' },
      pushed,
    ])
    expect(load).not.toHaveBeenCalled()
  })

  it('asks on-demand sources only while a view shows them, and keeps their values', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const providers = () => controller.snapshot().map((state) => state.provider)
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }], ['claude-code', 'grok', 'codex'])
    await vi.waitFor(() => expect(controller.snapshot()[0]?.status).toBe('ready'))
    expect(providers()).toEqual(['codex'])
    controller.changed('claude-code')
    controller.refresh()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load.mock.calls.map(([params]) => params)).toEqual([
      { provider: 'codex', intent: 'background' },
      { provider: 'codex', intent: 'background' },
    ])
    load.mockClear()

    // StrictMode closes and reopens a view in the same task; that asks once.
    controller.show()()
    const release = controller.show()
    // Listed as checking from the first paint.
    expect(controller.snapshot().map((state) => [state.provider, state.status])).toEqual([
      ['codex', 'ready'],
      ['claude-code', 'loading'],
      ['grok', 'loading'],
    ])
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )
    // Sources not asked yet take what the server holds first, then read afresh.
    expect(load.mock.calls.map(([params]) => params)).toEqual([
      { provider: 'claude-code', intent: 'visible' },
      { provider: 'grok', intent: 'visible' },
      { provider: 'codex', intent: 'refresh' },
      { provider: 'claude-code', intent: 'refresh' },
      { provider: 'grok', intent: 'refresh' },
    ])
    release()
    load.mockClear()

    controller.changed('grok')
    controller.refresh()
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(load).toHaveBeenCalledWith({ provider: 'codex', intent: 'background' })
    expect(providers()).toEqual(['codex', 'claude-code', 'grok'])
  })

  it('keeps a pushed on-demand source and catches it up once it becomes active', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }], ['claude-code'])
    await vi.waitFor(() => expect(controller.snapshot()[0]?.status).toBe('ready'))
    load.mockClear()
    const pushed: ProviderLimitSource = {
      provider: 'claude-code',
      status: 'ready',
      limits: [{ id: 'five_hour', label: '5h', usedPercent: 30 }],
    }

    controller.applySource(pushed)
    controller.applySource({ provider: 'grok', status: 'unavailable' })
    expect(controller.snapshot().map((state) => [state.provider, state.status])).toEqual([
      ['codex', 'ready'],
      ['claude-code', 'ready'],
    ])
    expect(controller.snapshot()[1]?.summary?.limitSource).toEqual(pushed)
    expect(load).not.toHaveBeenCalled()

    controller.select([{ provider: 'claude-code' }], ['codex'])
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(load).toHaveBeenCalledWith({ provider: 'claude-code', intent: 'background' })
    expect(controller.snapshot().map((state) => state.provider)).toEqual(['claude-code', 'codex'])
  })

  it('keeps each provider account a source of its own', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const controller = new UsageLimitsController(load)
    const work = { provider: 'codex', accountId: 'work-1a2b3c' } as const
    controller.select([{ provider: 'codex' }], [work, { provider: 'codex', accountId: 'default' }])
    await vi.waitFor(() => expect(controller.snapshot()[0]?.status).toBe('ready'))
    load.mockClear()

    // A push for another account never lands on the default account's bars.
    const pushed: ProviderLimitSource = {
      provider: 'codex',
      accountId: 'work-1a2b3c',
      status: 'ready',
      limits: [{ id: 'codex:primary', label: '5h', usedPercent: 80 }],
    }
    controller.applySource(pushed)
    controller.applySource({ ...pushed, accountId: 'other-000000' })
    expect(controller.snapshot()).toMatchObject([
      {
        provider: 'codex',
        status: 'ready',
        summary: { limitSource: summary('codex').limitSource },
      },
      { provider: 'codex', accountId: 'work-1a2b3c', status: 'ready' },
    ])
    expect(controller.snapshot()[0]).not.toHaveProperty('accountId')
    expect(controller.snapshot()[1]?.summary?.limitSource).toEqual(pushed)
    expect(load).not.toHaveBeenCalled()

    // Shown, the account is asked as itself; a change to it re-reads only it.
    const release = controller.show()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load).toHaveBeenCalledWith({ provider: 'codex', intent: 'refresh' })
    expect(load).toHaveBeenCalledWith({
      provider: 'codex',
      accountId: 'work-1a2b3c',
      intent: 'refresh',
    })
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )
    load.mockClear()
    controller.changed('codex', 'work-1a2b3c')
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(load).toHaveBeenCalledWith({
      provider: 'codex',
      accountId: 'work-1a2b3c',
      intent: 'visible',
    })
    controller.refresh('codex', 'retry', 'work-1a2b3c')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load).toHaveBeenLastCalledWith({
      provider: 'codex',
      accountId: 'work-1a2b3c',
      intent: 'retry',
    })
    release()
  })

  it('reads every source when it polls, on-demand ones included', async () => {
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params ? params.provider : 'codex'),
    )
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }], ['claude-code'])
    await vi.waitFor(() => expect(controller.snapshot()[0]?.status).toBe('ready'))
    load.mockClear()

    controller.poll()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3))
    expect(load.mock.calls.map(([params]) => params)).toEqual([
      { provider: 'claude-code', intent: 'background' },
      { provider: 'codex', intent: 'refresh' },
      { provider: 'claude-code', intent: 'refresh' },
    ])
    expect(controller.snapshot().map((state) => state.provider)).toEqual(['codex', 'claude-code'])
    // Polled, an on-demand source is still asked only while a view shows it.
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )
    load.mockClear()
    controller.refresh()
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(load).toHaveBeenCalledWith({ provider: 'codex', intent: 'background' })
  })

  it('polls every interval while the window shows, and catches up when it shows again', () => {
    vi.useFakeTimers()
    const page = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    })
    vi.stubGlobal('document', page)
    const controller = new UsageLimitsController(async () => summary('codex'))
    const poll = vi.spyOn(controller, 'poll').mockImplementation(() => {})
    const stop = pollUsageLimits(controller, 1_000)
    try {
      vi.advanceTimersByTime(999)
      expect(poll).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(poll).toHaveBeenCalledOnce()

      // Hidden, the window misses a read and makes it up once it shows again.
      page.visibilityState = 'hidden'
      vi.advanceTimersByTime(1_500)
      expect(poll).toHaveBeenCalledOnce()
      page.visibilityState = 'visible'
      page.dispatchEvent(new Event('visibilitychange'))
      expect(poll).toHaveBeenCalledTimes(2)
      // Showing again soon after a read asks nothing more.
      page.dispatchEvent(new Event('visibilitychange'))
      expect(poll).toHaveBeenCalledTimes(2)

      stop()
      vi.advanceTimersByTime(5_000)
      page.dispatchEvent(new Event('visibilitychange'))
      expect(poll).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('switches the active source to another account without showing the old limits', async () => {
    let resolveWork: ((value: Summary) => void) | undefined
    const load = vi.fn((params: ParamsOf<'usage.summary'>) =>
      'accountId' in params && params.accountId
        ? new Promise<Summary>((resolve) => {
            resolveWork = resolve
          })
        : Promise.resolve(summary('codex')),
    )
    const controller = new UsageLimitsController(load)
    controller.select([{ provider: 'codex' }])
    await vi.waitFor(() => expect(controller.snapshot()[0]?.status).toBe('ready'))

    controller.select([{ provider: 'codex', accountId: 'work-1a2b3c' }])
    expect(controller.snapshot()).toEqual([
      { status: 'loading', provider: 'codex', accountId: 'work-1a2b3c' },
    ])
    await vi.waitFor(() => expect(resolveWork).toBeDefined())
    resolveWork?.(summary('codex'))
    await vi.waitFor(() => expect(controller.snapshot()[0]?.status).toBe('ready'))
    expect(controller.snapshot()[0]).toMatchObject({ accountId: 'work-1a2b3c' })
  })

  it('coalesces change bursts for only the matching source', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async (params: ParamsOf<'usage.summary'>) =>
      summary('provider' in params && params.provider === 'claude-code' ? 'claude-code' : 'codex'),
    )
    const controller = new UsageLimitsController(load, 50)
    controller.select([{ provider: 'codex' }, { provider: 'claude-code' }])
    await vi.waitFor(() =>
      expect(controller.snapshot().every((state) => state.status === 'ready')).toBe(true),
    )
    load.mockClear()

    controller.changed('claude-code')
    controller.changed('claude-code')
    controller.changed('grok')
    await vi.advanceTimersByTimeAsync(50)

    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith({ provider: 'claude-code', intent: 'background' })
    vi.useRealTimers()
  })
})
