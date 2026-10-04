import type { ProviderId, ResultOf } from '@harness/contracts'
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
    expect(load).toHaveBeenNthCalledWith(1, { threadId: 'thread-a' })
    expect(load).toHaveBeenNthCalledWith(2, { provider: 'grok' })
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
