import type { ParamsOf, ProviderId, ProviderLimitSource, ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageSummaryController } from './usage-summary-state.js'

type Summary = ResultOf<'usage.summary'>
type DeferredFailure = Error | string

const summary = (marker: number): Summary => ({
  session: {
    inputTokens: marker,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: marker,
  },
  today: {
    inputTokens: marker,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: marker,
  },
  limits: [],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: DeferredFailure) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.useRealTimers())

async function settle(): Promise<void> {
  for (let step = 0; step < 5; step += 1) await Promise.resolve()
}

describe('UsageSummaryController', () => {
  it('keeps same-target values through a failed refresh', async () => {
    const first = deferred<Summary>()
    const second = deferred<Summary>()
    const reads = [first, second]
    const load = vi.fn(() => reads.shift()!.promise)
    const state = new UsageSummaryController(load)

    state.select({ provider: 'codex', threadId: 'thread-a' })
    expect(state.snapshot()).toEqual({ status: 'loading', provider: 'codex' })
    first.resolve(summary(1))
    await settle()
    expect(state.snapshot()).toEqual({ status: 'ready', provider: 'codex', summary: summary(1) })

    state.refresh()
    expect(state.snapshot()).toEqual({ status: 'loading', provider: 'codex', summary: summary(1) })
    second.reject(new Error('Temporary provider failure'))
    await settle()
    expect(state.snapshot()).toEqual({
      status: 'error',
      provider: 'codex',
      message: 'Temporary provider failure',
      summary: summary(1),
    })
  })

  it('clears on a target switch and ignores the superseded response', async () => {
    const codex = deferred<Summary>()
    const grok = deferred<Summary>()
    const load = vi.fn((_params: { provider: ProviderId } | { threadId: string }) =>
      load.mock.calls.length === 1 ? codex.promise : grok.promise,
    )
    const state = new UsageSummaryController(load)

    state.select({ provider: 'codex', threadId: 'thread-a' })
    state.select({ provider: 'grok' })
    expect(state.snapshot()).toEqual({ status: 'loading', provider: 'grok' })

    codex.resolve(summary(1))
    await settle()
    expect(state.snapshot()).toEqual({ status: 'loading', provider: 'grok' })
    grok.resolve(summary(2))
    await settle()
    expect(state.snapshot()).toEqual({ status: 'ready', provider: 'grok', summary: summary(2) })
    // Without a reason from its owner, a request counts as a shown view.
    expect(load).toHaveBeenNthCalledWith(1, { threadId: 'thread-a', intent: 'visible' })
    expect(load).toHaveBeenNthCalledWith(2, { provider: 'grok', intent: 'visible' })
  })

  it('keeps the account limits while another thread of the same provider loads', async () => {
    const first = deferred<Summary>()
    const second = deferred<Summary>()
    const reads = [first, second]
    const load = vi.fn(() => reads.shift()!.promise)
    const state = new UsageSummaryController(load)
    const withLimits: Summary = {
      ...summary(1),
      limits: [{ label: '5h', usedPercent: 40 }],
      limitSource: {
        provider: 'codex',
        status: 'ready',
        limits: [{ label: '5h', usedPercent: 40 }],
      },
    }

    state.select({ provider: 'codex', threadId: 'thread-a' })
    first.resolve(withLimits)
    await settle()
    state.select({ provider: 'codex', threadId: 'thread-b' })
    expect(state.snapshot()).toEqual({ status: 'loading', provider: 'codex', summary: withLimits })

    second.resolve(summary(2))
    await settle()
    expect(state.snapshot()).toEqual({ status: 'ready', provider: 'codex', summary: summary(2) })
    expect(load).toHaveBeenLastCalledWith({ threadId: 'thread-b', intent: 'visible' })
  })

  it('applies pushed limits without a request and keeps them over an older answer', async () => {
    const first = deferred<Summary>()
    const second = deferred<Summary>()
    const reads = [first, second]
    const load = vi.fn(() => reads.shift()!.promise)
    const state = new UsageSummaryController(load)
    const source = (usedPercent: number, checkedAt: number): ProviderLimitSource => ({
      provider: 'codex',
      status: 'ready',
      limits: [{ id: 'codex:primary', label: '5h', usedPercent }],
      checkedAt,
    })
    const answer = (marker: number, limits: ProviderLimitSource): Summary => ({
      ...summary(marker),
      limits: limits.status === 'ready' ? limits.limits : [],
      limitSource: limits,
    })

    state.select({ provider: 'codex' })
    first.resolve(answer(1, source(10, 100)))
    await settle()
    state.applySource({ ...source(99, 300), provider: 'grok' })
    state.applySource(source(30, 200))
    expect(state.snapshot()).toEqual({
      status: 'ready',
      provider: 'codex',
      summary: answer(1, source(30, 200)),
    })
    expect(load).toHaveBeenCalledOnce()

    // A read in flight stays loading; its older answer brings only its totals.
    state.refresh()
    state.applySource(source(35, 250))
    expect(state.snapshot()).toMatchObject({ status: 'loading' })
    second.resolve(answer(2, source(20, 150)))
    await settle()
    expect(state.snapshot()).toEqual({
      status: 'ready',
      provider: 'codex',
      summary: answer(2, source(35, 250)),
    })
  })

  it('turns a failed read into values when a snapshot is pushed', async () => {
    const first = deferred<Summary>()
    const state = new UsageSummaryController(() => first.promise)
    state.select({ provider: 'grok' })
    first.reject(new Error('Grok billing request failed.'))
    await settle()
    const pushed: ProviderLimitSource = {
      provider: 'grok',
      status: 'ready',
      limits: [{ id: 'weekly', label: 'Weekly', usedPercent: 12 }],
    }

    state.applySource(pushed)

    expect(state.snapshot()).toEqual({
      status: 'ready',
      provider: 'grok',
      summary: {
        session: summary(0).session,
        today: summary(0).today,
        limits: pushed.limits,
        limitSource: pushed,
      },
    })
  })

  it('asks with the reason its owner gives at the time of each request', async () => {
    let intent: 'background' | 'visible' = 'background'
    const load = vi.fn(async (_params: ParamsOf<'usage.summary'>) => summary(1))
    const state = new UsageSummaryController(load, 100, () => intent)

    state.select({ provider: 'codex' })
    await settle()
    intent = 'visible'
    state.refresh()
    await settle()
    expect(load.mock.calls.map(([params]) => params)).toEqual([
      { provider: 'codex', intent: 'background' },
      { provider: 'codex', intent: 'visible' },
    ])
  })

  it('keeps a retry for the request after the one in flight, over a weaker reason', async () => {
    const first = deferred<Summary>()
    const load = vi
      .fn((_params: ParamsOf<'usage.summary'>) => Promise.resolve(summary(2)))
      .mockReturnValueOnce(first.promise)
    const state = new UsageSummaryController(load, 100, () => 'background')

    state.select({ provider: 'claude-code' })
    state.refresh('retry')
    state.refresh('visible')
    first.reject(new Error('Claude usage request timed out.'))
    await settle()
    // One retry, and the request after it falls back to the owner's reason.
    state.refresh()
    await settle()
    expect(load.mock.calls.map(([params]) => params)).toEqual([
      { provider: 'claude-code', intent: 'background' },
      { provider: 'claude-code', intent: 'retry' },
      { provider: 'claude-code', intent: 'background' },
    ])
  })

  it('filters provider pushes and coalesces bursts during and after a read', async () => {
    vi.useFakeTimers()
    const first = deferred<Summary>()
    const second = deferred<Summary>()
    const third = deferred<Summary>()
    const reads = [first, second, third]
    const load = vi.fn(() => reads.shift()!.promise)
    const state = new UsageSummaryController(load, 100)

    state.select({ provider: 'codex' })
    first.resolve(summary(1))
    await settle()

    state.changed('claude-code')
    state.changed('codex')
    await vi.advanceTimersByTimeAsync(90)
    state.changed('codex')
    await vi.advanceTimersByTimeAsync(90)
    state.changed('codex')
    await vi.advanceTimersByTimeAsync(99)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(2)

    state.changed('codex')
    state.changed('codex')
    await vi.advanceTimersByTimeAsync(100)
    expect(load).toHaveBeenCalledTimes(2)
    second.resolve(summary(2))
    await settle()
    expect(load).toHaveBeenCalledTimes(3)
    third.resolve(summary(3))
    await settle()
    expect(state.snapshot()).toEqual({ status: 'ready', provider: 'codex', summary: summary(3) })
  })

  it('bounds non-Error messages and stops scheduled work after disposal', async () => {
    vi.useFakeTimers()
    const initial = deferred<Summary>()
    const load = vi.fn(() => initial.promise)
    const state = new UsageSummaryController(load)
    state.select({ provider: 'grok' })
    initial.reject('x'.repeat(500))
    await settle()

    const current = state.snapshot()
    expect(current).toBeDefined()
    if (!current) throw new Error('missing usage state')
    expect(current.status).toBe('error')
    expect(current.status === 'error' ? current.message.length : 0).toBe(300)
    state.changed('grok')
    state.dispose()
    await vi.runAllTimersAsync()
    expect(load).toHaveBeenCalledOnce()
  })

  it('recovers when the loader throws synchronously', async () => {
    const load = vi
      .fn<() => Promise<Summary>>()
      .mockImplementationOnce(() => {
        throw new Error('socket send failed')
      })
      .mockResolvedValueOnce(summary(2))
    const state = new UsageSummaryController(load)

    state.select({ provider: 'api' })
    await settle()
    expect(state.snapshot()).toEqual({
      status: 'error',
      provider: 'api',
      message: 'socket send failed',
    })

    state.refresh()
    await settle()
    expect(state.snapshot()).toEqual({ status: 'ready', provider: 'api', summary: summary(2) })
  })

  it('publishes one loading transition per target selection', () => {
    const load = vi.fn(() => new Promise<Summary>(() => undefined))
    const state = new UsageSummaryController(load)
    const listener = vi.fn()
    state.subscribe(listener)

    state.select({ provider: 'codex' })

    expect(listener).toHaveBeenCalledOnce()
    expect(state.snapshot()).toEqual({ status: 'loading', provider: 'codex' })
  })
})
