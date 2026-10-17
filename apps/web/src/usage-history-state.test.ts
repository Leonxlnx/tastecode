// @vitest-environment happy-dom
import type { ParamsOf, ResultOf, UsageHistoryRange, UsageHistoryTotals } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndeterminateRequestError } from './transport.js'
import { cacheHitRate, UsageHistoryController, type PageVisibility } from './usage-history-state.js'

type History = ResultOf<'usage.history'>

afterEach(() => vi.useRealTimers())

function history(range: UsageHistoryRange, scanning = false, marker = 1): History {
  const totals = usageTotals({ processedTokens: marker })
  return {
    range,
    startDate: '2026-10-01',
    endDate: '2026-10-17',
    generatedAt: marker,
    sessionCount: 1,
    activeDays: 1,
    totals,
    providers: [],
    models: [],
    daily: [],
    sources: [],
    scan: scanning
      ? { status: 'scanning', filesProcessed: 1, filesTotal: 10 }
      : { status: 'idle', filesProcessed: 10, filesTotal: 10 },
    warnings: [],
  }
}

function usageTotals(values: Partial<UsageHistoryTotals>): UsageHistoryTotals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    processedTokens: 0,
    estimatedCostUsd: 0,
    cacheSavingsUsd: 0,
    providerReportedCostUsd: 0,
    providerReportedTokens: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    ...values,
  }
}

function visibility() {
  let hidden = false
  const listeners = new Set<() => void>()
  const page: PageVisibility = {
    hidden: () => hidden,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    page,
    listeners,
    set(next: boolean) {
      hidden = next
      for (const listener of listeners) listener()
    },
  }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('UsageHistoryController', () => {
  it('polls a running scan at 2 s, backs off to 10 s and stops when it finishes', async () => {
    vi.useFakeTimers()
    let reads = 0
    const load = vi.fn(async (params: { range: UsageHistoryRange }) => {
      reads += 1
      return history(params.range, reads < 7)
    })
    const controller = new UsageHistoryController(load, { visibility: visibility().page })
    controller.watch('30d')
    await settle()
    expect(load).toHaveBeenCalledTimes(1)

    const waits: number[] = []
    let elapsed = 0
    while (load.mock.calls.length < 7) {
      const before = load.mock.calls.length
      await vi.advanceTimersByTimeAsync(250)
      elapsed += 250
      if (load.mock.calls.length > before) {
        waits.push(elapsed)
        elapsed = 0
      }
    }
    expect(waits).toEqual([2_000, 3_000, 4_500, 6_750, 10_000, 10_000])
    expect(controller.snapshot('30d').data?.scan.status).toBe('idle')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(7)
  })

  it('does not read while the window is hidden and catches up when it is shown', async () => {
    vi.useFakeTimers()
    const page = visibility()
    const load = vi.fn(async (params: { range: UsageHistoryRange }) => history(params.range, true))
    const controller = new UsageHistoryController(load, { visibility: page.page })
    controller.watch('all')
    await settle()
    expect(load).toHaveBeenCalledTimes(1)

    page.set(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(load).toHaveBeenCalledTimes(1)

    page.set(false)
    await settle()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('stops polling when the last page leaves and unsubscribes from visibility', async () => {
    vi.useFakeTimers()
    const page = visibility()
    const load = vi.fn(async (params: { range: UsageHistoryRange }) => history(params.range, true))
    const controller = new UsageHistoryController(load, { visibility: page.page })
    const release = controller.watch('30d')
    await settle()
    expect(page.listeners.size).toBe(1)

    release()
    release()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(page.listeners.size).toBe(0)
  })

  it('shares one answer between pages and paints a range picked again from the cache', async () => {
    vi.useFakeTimers()
    let now = 0
    const load = vi.fn(async (params: { range: UsageHistoryRange }) => history(params.range))
    const controller = new UsageHistoryController(load, {
      visibility: visibility().page,
      now: () => now,
    })
    const usage = controller.watch('30d')
    const profile = controller.watch('all')
    controller.watch('all')()
    await settle()
    expect(load.mock.calls.map(([params]) => params.range)).toEqual(['30d', 'all'])
    const cached = controller.snapshot('30d')
    usage()
    profile()

    controller.watch('30d')
    expect(controller.snapshot('30d')).toBe(cached)
    expect(load).toHaveBeenCalledTimes(2)

    now = 6_000
    controller.watch('30d')
    expect(controller.snapshot('30d')).toEqual({ ...cached, loading: true })
    await settle()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('retries an unconfirmed failure once before it shows, and keeps the last answer', async () => {
    vi.useFakeTimers()
    const answers: Array<() => History> = [
      () => history('30d', false, 1),
      () => {
        throw new IndeterminateRequestError('Connection to the server was lost.')
      },
      () => {
        throw new IndeterminateRequestError('Connection to the server was lost.')
      },
    ]
    const load = vi.fn(async () => answers.shift()!())
    const controller = new UsageHistoryController(load, { visibility: visibility().page })
    controller.watch('30d')
    await settle()
    const first = controller.snapshot('30d').data

    controller.refresh('30d')
    await settle()
    expect(controller.snapshot('30d')).toEqual({ data: first, loading: true, error: undefined })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(controller.snapshot('30d')).toEqual({
      data: first,
      loading: false,
      error: 'Connection to the server was lost.',
    })
  })

  it('keeps following a running scan after an ordinary failure', async () => {
    vi.useFakeTimers()
    const answers: Array<() => History> = [
      () => history('all', true),
      () => {
        throw new Error('Temporary history failure')
      },
      () => history('all', false),
    ]
    const load = vi.fn(async () => answers.shift()!())
    const controller = new UsageHistoryController(load, { visibility: visibility().page })
    controller.watch('all')
    await settle()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(controller.snapshot('all').error).toBe('Temporary history failure')
    expect(controller.snapshot('all').data?.scan.status).toBe('scanning')

    await vi.advanceTimersByTimeAsync(3_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(controller.snapshot('all')).toMatchObject({ loading: false, error: undefined })
    expect(controller.snapshot('all').data?.scan.status).toBe('idle')
  })

  it('runs a rescan asked for during a read once that read has answered', async () => {
    vi.useFakeTimers()
    let finish: (value: History) => void = () => {}
    const load = vi
      .fn<(params: ParamsOf<'usage.history'>) => Promise<History>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockImplementation(async (params) => history(params.range))
    const controller = new UsageHistoryController(load, { visibility: visibility().page })
    controller.watch('7d')
    await settle()

    controller.refresh('7d')
    expect(load).toHaveBeenCalledTimes(1)
    finish(history('7d'))
    await settle()
    expect(load).toHaveBeenLastCalledWith({ range: '7d', refresh: true })
  })

  it('counts cache writes as input in the cache hit rate', () => {
    expect(
      cacheHitRate(
        usageTotals({
          uncachedInputTokens: 100,
          cachedInputTokens: 800,
          cacheWriteInputTokens: 100,
        }),
      ),
    ).toBe(0.8)
    expect(cacheHitRate(usageTotals({ outputTokens: 10 }))).toBeUndefined()
  })
})
