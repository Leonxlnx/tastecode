// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ProviderLimit, ProviderLimitSource, ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageSummaryState } from '../../usage-summary-state.js'
import { resetCountdown, UsageLimits, type PlanLimitsSource } from './UsageLimits.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = Date.UTC(2026, 9, 17, 10, 0)

describe('usage page plan limits', () => {
  it('lists every provider’s windows with the share left and when they reset', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const source = fakeSource([
      ready('claude-code', [
        limit({ label: 'Session', usedPercent: 79, resetsAt: NOW + 8 * 60_000 }),
        limit({ label: 'Weekly', usedPercent: 0, resetsAt: NOW + 3 * 86_400_000 }),
      ]),
      ready('codex', [limit({ label: 'Credits', usedPercent: 0, valueLabel: '$209.60' })]),
    ])
    render(<UsageLimits source={source} />)

    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('21% left')).toBeTruthy()
    expect(within(claude).getByText('Resets in 8m')).toBeTruthy()
    expect(within(claude).getByText(/^Resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) /)).toBeTruthy()
    expect(
      within(claude)
        .getByRole('progressbar', { name: 'Claude Code Session left' })
        .getAttribute('aria-valuenow'),
    ).toBe('21')
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText('$209.60')).toBeTruthy()
    expect(within(codex).queryByRole('progressbar')).toBeNull()
  })

  it('marks a window that is used up and one that is running low', () => {
    const source = fakeSource([
      ready('codex', [
        limit({ label: 'Weekly', usedPercent: 100 }),
        limit({ label: 'Session', usedPercent: 99.6 }),
      ]),
    ])
    render(<UsageLimits source={source} />)

    const rows = document.querySelectorAll('.usage-limit')
    expect(rows[0]?.getAttribute('data-state')).toBe('blocked')
    expect(within(rows[0] as HTMLElement).getByText('Limit reached')).toBeTruthy()
    expect(rows[1]?.getAttribute('data-state')).toBe('low')
    expect(within(rows[1] as HTMLElement).getByText('0% left')).toBeTruthy()
  })

  it('keeps the last values through a failed refresh and offers a retry', () => {
    const source = fakeSource([
      {
        status: 'error',
        provider: 'claude-code',
        message: 'Claude usage request timed out.',
        summary: summary({
          provider: 'claude-code',
          status: 'ready',
          limits: [limit({ label: 'Session', usedPercent: 10 })],
        }),
      },
      {
        status: 'error',
        provider: 'grok',
        message: 'grok billing did not answer in time',
      },
    ])
    render(<UsageLimits source={source} />)

    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('Last known')).toBeTruthy()
    expect(within(claude).getByText('90% left')).toBeTruthy()
    const grok = screen.getByRole('region', { name: 'Grok' })
    expect(within(grok).getByText('Unavailable')).toBeTruthy()
    fireEvent.click(within(grok).getByRole('button', { name: 'Retry' }))
    expect(source.refresh).toHaveBeenCalledWith('grok')
  })

  it('leaves out providers without plan limits and says so when none has any', () => {
    const source = fakeSource([
      {
        status: 'ready',
        provider: 'codex',
        summary: summary({ provider: 'codex', status: 'unavailable' }),
      },
    ])
    render(<UsageLimits source={source} />)

    expect(screen.queryByRole('region', { name: 'Codex' })).toBeNull()
    expect(screen.getByText('None of your providers reports plan limits.')).toBeTruthy()
  })

  it('follows the owner’s updates', () => {
    const source = fakeSource([])
    render(<UsageLimits source={source} />)
    expect(screen.getByText('None of your providers reports plan limits.')).toBeTruthy()

    act(() => source.set([ready('codex', [limit({ label: 'Weekly', usedPercent: 40 })])]))
    expect(screen.getByText('60% left')).toBeTruthy()
  })

  it('counts down within a day and names the day or date beyond it', () => {
    expect(resetCountdown(NOW - 1, NOW)?.label).toBe('Resets now')
    expect(resetCountdown(NOW + 42 * 60_000, NOW)?.label).toBe('Resets in 42m')
    expect(resetCountdown(NOW + 3 * 3_600_000, NOW)?.label).toBe('Resets in 3h')
    expect(resetCountdown(NOW + 3 * 3_600_000 + 12 * 60_000, NOW)?.label).toBe('Resets in 3h 12m')
    expect(resetCountdown(NOW + 2 * 86_400_000, NOW)?.label).toMatch(
      /^Resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \S/,
    )
    expect(resetCountdown(NOW + 20 * 86_400_000, NOW)?.label).toMatch(/^Resets Nov \d+$/)
    expect(resetCountdown(Number.NaN, NOW)).toBeUndefined()
  })
})

type FakeSource = PlanLimitsSource & {
  set(states: UsageSummaryState[]): void
  refresh: ReturnType<typeof vi.fn<PlanLimitsSource['refresh']>>
}

function fakeSource(initial: UsageSummaryState[]): FakeSource {
  let states = initial
  const listeners = new Set<() => void>()
  const source: FakeSource = {
    snapshot: () => states,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: vi.fn<PlanLimitsSource['refresh']>(),
    set(next) {
      states = next
      for (const listener of listeners) listener()
    },
  }
  return source
}

function ready(
  provider: ProviderLimitSource['provider'],
  limits: ProviderLimit[],
): UsageSummaryState {
  return { status: 'ready', provider, summary: summary({ provider, status: 'ready', limits }) }
}

function summary(source: ProviderLimitSource): ResultOf<'usage.summary'> {
  const none = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  return {
    session: none,
    today: none,
    limits: source.status === 'ready' ? source.limits : [],
    limitSource: source,
  }
}

function limit(values: Partial<ProviderLimit> & { label: string }): ProviderLimit {
  return { usedPercent: 0, ...values }
}
