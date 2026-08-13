import type { ParamsOf, ProviderId, ResultOf } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import { UsageLimitsController } from './usage-limits-state.js'

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
    expect(load).toHaveBeenCalledWith({ provider: 'codex' })
    expect(load).toHaveBeenCalledWith({ provider: 'claude-code' })
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
    expect(load).toHaveBeenCalledWith({ provider: 'claude-code' })
    vi.useRealTimers()
  })
})
