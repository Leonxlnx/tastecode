// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountLimits, type AccountLimitsState } from './AccountLimits.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const summary = (limits: ResultOf<'usage.summary'>['limits'] = []): ResultOf<'usage.summary'> => ({
  session: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  },
  today: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  },
  limits,
})

function limits(
  state: AccountLimitsState,
  onRetry = () => {},
  onConsumeReset?: (
    provider: AccountLimitsState['provider'],
    idempotencyKey: string,
    creditId?: string,
  ) => Promise<ResultOf<'usage.consumeReset'>>,
) {
  return <AccountLimits states={[state]} onRetry={onRetry} onConsumeReset={onConsumeReset} />
}

function statusOf(region: HTMLElement): HTMLElement | null {
  return region.querySelector<HTMLElement>('.account-menu__source-status')
}

const resetLimit = {
  label: 'Rate limit resets',
  usedPercent: 0,
  valueLabel: '1 available',
  action: 'consume-reset' as const,
}

const resetState: AccountLimitsState = {
  status: 'ready',
  provider: 'codex',
  summary: {
    ...summary(),
    limitSource: { provider: 'codex', status: 'ready', limits: [resetLimit] },
  },
}

describe('account limits', () => {
  it('shows every provider at once, with no summary row to expand', () => {
    render(
      <AccountLimits
        states={[
          {
            status: 'ready',
            provider: 'grok',
            summary: summary([{ label: 'Weekly', usedPercent: 10 }]),
          },
          {
            status: 'ready',
            provider: 'codex',
            summary: summary([{ label: 'Weekly', usedPercent: 12 }]),
          },
        ]}
        onRetry={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: /Usage/ })).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Grok' })).getByText('90% left')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Codex' })).getByText('88% left')).toBeTruthy()
    const panel = screen.getByRole('region', { name: 'Plan limits' })
    // The popup lands on the list, not on its first Retry or Use button.
    expect(document.activeElement).toBe(panel)
    expect(panel.tabIndex).toBe(0)
    expect(statusOf(screen.getByRole('region', { name: 'Codex' }))).toBeNull()
  })

  it('says once that the limits are on screen and releases that when it closes', () => {
    const release = vi.fn()
    const onShow = vi.fn(() => release)
    const state: AccountLimitsState = {
      status: 'ready',
      provider: 'codex',
      summary: summary([{ label: 'Weekly', usedPercent: 12 }]),
    }
    const view = render(<AccountLimits states={[state]} onShow={onShow} onRetry={() => {}} />)
    expect(onShow).toHaveBeenCalledOnce()
    // New states and a new callback identity are no new showing.
    view.rerender(
      <AccountLimits
        states={[{ ...state, status: 'loading' }]}
        onShow={() => release}
        onRetry={() => {}}
      />,
    )
    expect(onShow).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    view.unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps a source that was not read yet in view, as checking while it loads', () => {
    const onRetry = vi.fn()
    const notRead: AccountLimitsState = {
      status: 'ready',
      provider: 'claude-code',
      summary: {
        ...summary(),
        limitSource: {
          provider: 'claude-code',
          status: 'unavailable',
          reason: 'failed',
          error: 'Plan limits are read when you open them.',
        },
      },
    }
    const view = render(
      <AccountLimits states={[{ ...notRead, status: 'loading' }]} onRetry={onRetry} />,
    )
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(statusOf(claude)?.textContent).toBe('Checking…')
    expect(within(claude).queryByRole('button', { name: 'Retry' })).toBeNull()

    // An answer that still has no values says why and can be asked again.
    view.rerender(<AccountLimits states={[notRead]} onRetry={onRetry} />)
    const status = statusOf(screen.getByRole('region', { name: 'Claude Code' }))!
    expect(status.firstChild?.textContent).toBe('Unavailable')
    expect(status.title).toBe(
      'Plan limits couldn’t be loaded. Plan limits are read when you open them.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('claude-code')
  })

  it('keeps ordered provider states and hides sources without limits', () => {
    render(
      <AccountLimits
        states={[
          { status: 'loading', provider: 'codex' },
          {
            status: 'ready',
            provider: 'claude-code',
            summary: {
              ...summary(),
              limitSource: { provider: 'claude-code', status: 'ready', limits: [] },
            },
          },
          {
            status: 'ready',
            provider: 'grok',
            summary: {
              ...summary(),
              limitSource: { provider: 'grok', status: 'unavailable' },
            },
          },
        ]}
        onRetry={vi.fn()}
      />,
    )

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Codex', 'Claude Code'])
    expect(statusOf(screen.getByRole('region', { name: 'Codex' }))?.textContent).toBe('Checking…')
    const claude = statusOf(screen.getByRole('region', { name: 'Claude Code' }))
    expect(claude?.textContent).toBe('None reported. No plan limits reported.')
    expect(claude?.title).toBe('No plan limits reported.')
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()
  })

  it('reports a failed provider as one muted line with a text Retry, never an alert', () => {
    const onRetry = vi.fn()
    render(
      <AccountLimits
        states={[
          { status: 'error', provider: 'claude-code', message: 'Claude usage request failed.' },
          {
            status: 'ready',
            provider: 'codex',
            summary: summary([{ label: 'Weekly', usedPercent: 29 }]),
          },
        ]}
        onRetry={onRetry}
      />,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    const status = statusOf(claude)!
    // The reason is there for hover and assistive tech, not printed in the list.
    expect(status.firstChild?.textContent).toBe('Unavailable')
    expect(status.title).toBe('Plan limits couldn’t be loaded. Claude usage request failed.')
    expect(status.querySelector('.visually-hidden')?.textContent).toContain(
      'Claude usage request failed.',
    )
    expect(within(claude).queryByRole('progressbar')).toBeNull()

    const retry = within(claude).getByRole('button', { name: 'Retry' })
    expect(retry.getAttribute('aria-describedby')).toBe(status.id)
    expect(retry.classList.contains('account-menu__retry')).toBe(true)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledWith('claude-code')
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Plan limits' }))
  })

  it('keeps last known values and retries each source independently', () => {
    const onRetry = vi.fn()
    render(
      <AccountLimits
        states={[
          { status: 'error', provider: 'codex', message: 'Offline' },
          {
            status: 'loading',
            provider: 'claude-code',
            summary: summary([{ label: 'Weekly', usedPercent: 25 }]),
          },
          {
            status: 'error',
            provider: 'grok',
            message: 'Timed out',
            summary: summary([{ label: 'Credits', usedPercent: 0, valueLabel: '$8.24' }]),
          },
        ]}
        onRetry={onRetry}
      />,
    )

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Codex', 'Claude Code', 'Grok'])

    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(statusOf(codex)?.firstChild?.textContent).toBe('Unavailable')
    fireEvent.click(within(codex).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('codex')

    // A refresh with values on screen is quiet: the values stay, nothing flickers.
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('75% left')).toBeTruthy()
    expect(statusOf(claude)).toBeNull()
    expect(claude.getAttribute('aria-busy')).toBe('true')

    const grok = screen.getByRole('region', { name: 'Grok' })
    const grokValue = within(grok).getByText('$8.24')
    expect(grokValue.classList.contains('account-menu__limit-value')).toBe(true)
    expect(statusOf(grok)?.firstChild?.textContent).toBe('Last known')
    expect(statusOf(grok)?.title).toBe('Couldn’t refresh plan limits. Timed out')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('labels values the server kept through a failed refresh, without a Retry', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 + 2 * 3_600_000 })
    const kept = [{ id: 'five_hour', label: 'Session', usedPercent: 42 }]
    render(
      <AccountLimits
        states={[
          {
            status: 'ready',
            provider: 'claude-code',
            summary: {
              ...summary(kept),
              limitSource: {
                provider: 'claude-code',
                status: 'ready',
                limits: kept,
                checkedAt: 1_000,
                stale: true,
                refreshError: 'Claude usage request timed out.',
                retryAt: 2_000,
              },
            },
          },
          {
            status: 'ready',
            provider: 'grok',
            summary: {
              ...summary(kept),
              limitSource: { provider: 'grok', status: 'ready', limits: kept, stale: true },
            },
          },
        ]}
        onRetry={vi.fn()}
      />,
    )

    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('58% left')).toBeTruthy()
    // It says how old the values are instead of raising an error.
    expect(statusOf(claude)?.firstChild?.textContent).toBe('Last known · 2h ago')
    expect(statusOf(claude)?.title).toBe(
      'Couldn’t refresh plan limits. Claude usage request timed out.',
    )
    // The server already retries on its own schedule.
    expect(within(claude).queryByRole('button', { name: 'Retry' })).toBeNull()
    const grok = screen.getByRole('region', { name: 'Grok' })
    // Without a read time it cannot say how old.
    expect(statusOf(grok)?.firstChild?.textContent).toBe('Last known')
    expect(statusOf(grok)?.title).toBe('Couldn’t refresh plan limits.')
  })

  it('says when values were updated once they are older than ten minutes', () => {
    const now = 50 * 60_000
    vi.useFakeTimers({ toFake: ['Date'], now })
    const row = [{ id: 'five_hour', label: 'Session', usedPercent: 42 }]
    const state = (
      provider: AccountLimitsState['provider'],
      checkedAt: number,
      origin: 'live' | 'read',
    ): AccountLimitsState => ({
      status: 'ready',
      provider,
      summary: {
        ...summary(row),
        limitSource: { provider, status: 'ready', limits: row, checkedAt, origin },
      },
    })
    const view = render(
      <AccountLimits
        states={[
          state('codex', now - 9 * 60_000, 'live'),
          state('claude-code', now - 12 * 60_000, 'live'),
          state('grok', now - 47 * 60_000, 'read'),
        ]}
        onRetry={vi.fn()}
      />,
    )

    expect(statusOf(screen.getByRole('region', { name: 'Codex' }))).toBeNull()
    expect(statusOf(screen.getByRole('region', { name: 'Claude Code' }))?.textContent).toBe(
      'Updated 12m ago',
    )
    expect(statusOf(screen.getByRole('region', { name: 'Grok' }))?.textContent).toBe(
      'Updated 47m ago',
    )
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('says how old last known values are when a refresh request failed', () => {
    const now = 3 * 86_400_000
    vi.useFakeTimers({ toFake: ['Date'], now })
    const row = [{ id: 'weekly', label: 'Weekly', usedPercent: 20 }]
    render(
      limits({
        status: 'error',
        provider: 'grok',
        message: 'Grok billing request failed.',
        summary: {
          ...summary(row),
          limitSource: {
            provider: 'grok',
            status: 'ready',
            limits: row,
            checkedAt: now - 30_000,
          },
        },
      }),
    )
    const grok = screen.getByRole('region', { name: 'Grok' })
    // Under a minute old, the age would only be noise.
    expect(statusOf(grok)?.firstChild?.textContent).toBe('Last known')
    expect(within(grok).getByText('80% left')).toBeTruthy()

    cleanup()
    render(
      limits({
        status: 'error',
        provider: 'grok',
        message: 'Grok billing request failed.',
        summary: {
          ...summary(row),
          limitSource: {
            provider: 'grok',
            status: 'ready',
            limits: row,
            checkedAt: now - 2 * 86_400_000,
          },
        },
      }),
    )
    expect(statusOf(screen.getByRole('region', { name: 'Grok' }))?.firstChild?.textContent).toBe(
      'Last known · 2d ago',
    )
  })

  it('orders and calms the nightly-only providers like the shipped ones', () => {
    const onRetry = vi.fn()
    render(
      <AccountLimits
        states={[
          { status: 'loading', provider: 'codex' },
          {
            status: 'ready',
            provider: 'claude-code',
            summary: {
              ...summary(),
              limitSource: { provider: 'claude-code', status: 'ready', limits: [] },
            },
          },
          {
            status: 'ready',
            provider: 'grok',
            summary: {
              ...summary(),
              limitSource: { provider: 'grok', status: 'unavailable' },
            },
          },
          { status: 'error', provider: 'opencode', message: 'Offline' },
          {
            status: 'loading',
            provider: 'cursor',
            summary: summary([{ label: 'Weekly', usedPercent: 25 }]),
          },
          {
            status: 'error',
            provider: 'api',
            message: 'Timed out',
            summary: summary([{ label: 'Credits', usedPercent: 0, valueLabel: '$8.24' }]),
          },
        ]}
        onRetry={onRetry}
      />,
    )

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Codex', 'Claude Code', 'OpenCode', 'Cursor', 'API connection'])
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()

    const openCode = screen.getByRole('region', { name: 'OpenCode' })
    expect(statusOf(openCode)?.firstChild?.textContent).toBe('Unavailable')
    fireEvent.click(within(openCode).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('opencode')

    const cursor = screen.getByRole('region', { name: 'Cursor' })
    expect(within(cursor).getByText('75% left')).toBeTruthy()
    expect(statusOf(cursor)).toBeNull()
    expect(cursor.getAttribute('aria-busy')).toBe('true')

    const api = screen.getByRole('region', { name: 'API connection' })
    const apiValue = within(api).getByText('$8.24')
    expect(apiValue.classList.contains('account-menu__limit-value')).toBe(true)
    expect(statusOf(api)?.firstChild?.textContent).toBe('Last known')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('distinguishes loading from an empty successful response', () => {
    const view = render(limits({ status: 'loading', provider: 'codex' }))
    const panel = screen.getByRole('region', { name: 'Plan limits' })
    expect(statusOf(screen.getByRole('region', { name: 'Codex' }))?.textContent).toBe('Checking…')
    expect(document.activeElement).toBe(panel)
    expect(panel.getAttribute('aria-busy')).toBe('true')

    view.rerender(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: {
          ...summary(),
          limitSource: { provider: 'codex', status: 'ready', limits: [] },
        },
      }),
    )
    expect(screen.queryByText('Checking…')).toBeNull()
    expect(statusOf(screen.getByRole('region', { name: 'Codex' }))?.title).toBe(
      'No plan limits reported.',
    )

    view.rerender(limits({ status: 'ready', provider: 'claude-code', summary: summary() }))
    expect(screen.queryByRole('region', { name: 'Plan limits' })).toBeNull()

    view.rerender(limits({ status: 'error', provider: 'grok', message: 'Offline' }))
    expect(screen.getByRole('region', { name: 'Grok' })).toBeTruthy()
  })

  it('labels available sources and omits providers without a limit source', () => {
    const state: AccountLimitsState = {
      status: 'ready',
      provider: 'codex',
      summary: {
        ...summary(),
        limitSource: {
          provider: 'codex',
          status: 'ready',
          limits: [
            { label: 'Weekly', usedPercent: 85 },
            { label: 'Credits', usedPercent: 0, valueLabel: '$12.40' },
          ],
        },
      },
    }
    const view = render(limits(state))

    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText('15% left')).toBeTruthy()
    expect(within(codex).getByText('$12.40')).toBeTruthy()
    const bar = within(codex).getByRole('progressbar', { name: 'Codex Weekly left' })
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('15%')

    view.rerender(
      limits({
        status: 'ready',
        provider: 'grok',
        summary: { ...summary(), limitSource: { provider: 'grok', status: 'unavailable' } },
      }),
    )
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()

    for (const emptySummary of [
      { ...summary(), limitSource: { provider: 'grok', status: 'unavailable' } as const },
      summary(),
    ]) {
      view.rerender(
        limits({ status: 'error', provider: 'grok', message: 'Offline', summary: emptySummary }),
      )
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()
    }
  })

  it('renders contract-valid reset boundaries honestly', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1))
    render(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: {
          ...summary(),
          limitSource: {
            provider: 'codex',
            status: 'ready',
            limits: [
              { label: 'Epoch', usedPercent: 0, resetsAt: 0 },
              { label: 'Far future', usedPercent: 0, resetsAt: Number.MAX_SAFE_INTEGER },
            ],
          },
        },
      }),
    )

    const epoch = screen.getByText('Epoch').closest('.account-menu__limit')
    const farFuture = screen.getByText('Far future').closest('.account-menu__limit')
    expect(epoch).not.toBeNull()
    expect(farFuture).not.toBeNull()
    expect(within(epoch as HTMLElement).getByText(/^Resets .*19(?:69|70)$/)).toBeTruthy()
    expect(within(farFuture as HTMLElement).getByText('Reset time unavailable.')).toBeTruthy()
  })

  it('shows every reset expiry soonest first, with dates and a strict 24-hour warning', () => {
    const now = Date.UTC(2026, 8, 13, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const credits = [
      { expiresAt: null },
      { expiresAt: now + 2 * 86_400_000 },
      { expiresAt: now + 86_400_000 },
      { expiresAt: now + 86_400_000 - 1 },
      { expiresAt: now + 3_600_000 },
    ]
    render(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: summary([{ ...resetLimit, valueLabel: '5 available', resetCredits: credits }]),
      }),
    )

    expect(
      within(screen.getByRole('region', { name: 'Codex' })).getByText('5 available'),
    ).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Rate limit reset expiries' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    const times = Array.from(list.querySelectorAll('time'))
    const expected = [now + 3_600_000, now + 86_400_000 - 1, now + 86_400_000, now + 2 * 86_400_000]
    expect(times.map((time) => time.dateTime)).toEqual(
      expected.map((at) => new Date(at).toISOString()),
    )
    expect(times.map((time) => time.hasAttribute('data-expiring-soon'))).toEqual([
      true,
      true,
      false,
      false,
    ])
    for (const [index, time] of times.entries()) {
      expect(time.textContent).toBe(
        `Expires ${new Date(expected[index]!).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })} ${new Date(expected[index]!).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      )
    }
    expect(list.lastElementChild?.textContent).toBe('No expiry')
    expect(credits[0]?.expiresAt).toBeNull()
  })

  it('reads the expiry warning when it opens and when values change, with no timer', () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 8, 13, 12)
    vi.setSystemTime(now)
    const state = (marker: number): AccountLimitsState => ({
      status: 'ready',
      provider: 'codex',
      summary: summary([
        {
          ...resetLimit,
          valueLabel: `${marker} available`,
          resetCredits: [{ expiresAt: now + 86_400_000 }],
        },
      ]),
    })
    const view = render(limits(state(1)))
    const time = () => screen.getByRole('list').querySelector('time')!
    expect(time().hasAttribute('data-expiring-soon')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    // Nothing ticks while it stays open; new values read the clock again.
    act(() => vi.advanceTimersByTime(60_000))
    expect(time().hasAttribute('data-expiring-soon')).toBe(false)
    view.rerender(limits(state(2)))
    expect(time().hasAttribute('data-expiring-soon')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles expired and invalid dates without inventing an expiry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 13))
    render(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: summary([
          {
            ...resetLimit,
            resetCredits: [{ expiresAt: 0 }, { expiresAt: Number.MAX_SAFE_INTEGER }],
          },
        ]),
      }),
    )
    expect(screen.getByText(/^Expired /).hasAttribute('data-expiring-soon')).toBe(false)
    expect(screen.getByText('Expiry date unavailable')).toBeTruthy()
  })

  it('preserves usable values through a failed refresh and retries', () => {
    const onRetry = vi.fn()
    const view = render(
      limits(
        {
          status: 'error',
          provider: 'claude-code',
          message: 'Temporary connection failure',
          summary: summary([{ label: 'Session', usedPercent: 42 }]),
        },
        onRetry,
      ),
    )
    const panel = screen.getByRole('region', { name: 'Plan limits' })
    const claude = screen.getByRole('region', { name: 'Claude Code' })

    expect(within(claude).getByText('58% left')).toBeTruthy()
    expect(statusOf(claude)?.firstChild?.textContent).toBe('Last known')
    expect(statusOf(claude)?.title).toBe(
      'Couldn’t refresh plan limits. Temporary connection failure',
    )
    expect(screen.queryByRole('alert')).toBeNull()
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    expect(document.activeElement).toBe(retry)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(panel)

    view.rerender(
      limits(
        {
          status: 'loading',
          provider: 'claude-code',
          summary: summary([{ label: 'Session', usedPercent: 42 }]),
        },
        onRetry,
      ),
    )
    expect(document.activeElement).toBe(panel)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('hides Use on ordinary quota rows and does not consume on the first press', async () => {
    const onConsumeReset = vi.fn(async () => ({ outcome: 'reset' as const }))
    render(
      limits(
        {
          status: 'ready',
          provider: 'codex',
          summary: {
            ...summary(),
            limitSource: {
              provider: 'codex',
              status: 'ready',
              limits: [{ label: 'Weekly', usedPercent: 100 }, resetLimit],
            },
          },
        },
        () => {},
        onConsumeReset,
      ),
    )

    const weekly = screen.getByText('Weekly').closest('.account-menu__limit') as HTMLElement
    expect(within(weekly).queryByRole('button', { name: 'Use rate limit reset' })).toBeNull()

    const use = screen.getByRole('button', { name: 'Use rate limit reset' })
    fireEvent.click(use)
    expect(onConsumeReset).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm use rate limit reset' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel using rate limit reset' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use rate limit reset' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel using rate limit reset' }))
    expect(onConsumeReset).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Use rate limit reset' })).toBeTruthy()
  })

  it('uses the reset beside the selected expiry and keeps that date visible during confirmation', async () => {
    const now = Date.UTC(2026, 8, 13, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const onConsumeReset = vi.fn(async () => ({ outcome: 'reset' as const }))
    render(
      limits(
        {
          status: 'ready',
          provider: 'codex',
          summary: summary([
            {
              ...resetLimit,
              valueLabel: '2 available',
              resetCredits: [
                { id: 'later', expiresAt: now + 2 * 86_400_000 },
                { id: 'soon', expiresAt: now + 3_600_000 },
              ],
            },
          ]),
        },
        () => {},
        onConsumeReset,
      ),
    )

    const heading = screen.getByText('Rate limit resets').parentElement!
    expect(within(heading).queryByRole('button')).toBeNull()
    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    const selected = rows[1]!
    const expiry = selected.querySelector('time')!
    expect(expiry.dateTime).toBe(new Date(now + 2 * 86_400_000).toISOString())
    const use = within(selected).getByRole('button', { name: 'Use rate limit reset' })
    expect(document.getElementById(use.getAttribute('aria-describedby')!)?.contains(expiry)).toBe(
      true,
    )
    fireEvent.click(use)
    expect(onConsumeReset).not.toHaveBeenCalled()
    expect(selected.contains(expiry)).toBe(true)
    expect(screen.getByText('Rate limit resets')).toBeTruthy()
    expect(within(heading).getByText('2 available')).toBeTruthy()
    fireEvent.click(within(selected).getByRole('button', { name: 'Confirm use rate limit reset' }))
    await waitFor(() =>
      expect(onConsumeReset).toHaveBeenCalledWith('codex', expect.any(String), 'later'),
    )
  })

  it('does not offer a dated reset without an id or after its expiry', () => {
    const now = Date.UTC(2026, 8, 13, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    render(
      limits(
        {
          status: 'ready',
          provider: 'codex',
          summary: summary([
            {
              ...resetLimit,
              resetCredits: [
                { id: 'expired', expiresAt: now - 1 },
                { expiresAt: now + 86_400_000 },
                { id: 'no-expiry', expiresAt: null },
              ],
            },
          ]),
        },
        () => {},
        vi.fn(),
      ),
    )
    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(within(rows[0]!).queryByRole('button')).toBeNull()
    expect(within(rows[1]!).queryByRole('button')).toBeNull()
    expect(within(rows[2]!).getByRole('button', { name: 'Use rate limit reset' })).toBeTruthy()
  })

  it('consumes only after Confirm, reuses the attempt key, and ignores a second press while pending', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const onConsumeReset = vi.fn()
    onConsumeReset.mockImplementationOnce(
      () =>
        new Promise<ResultOf<'usage.consumeReset'>>((_resolve, reject) => {
          rejectFirst = reject
        }),
    )
    onConsumeReset.mockRejectedValueOnce(new Error('Still failing'))
    render(limits(resetState, () => {}, onConsumeReset))

    fireEvent.click(screen.getByRole('button', { name: 'Use rate limit reset' }))
    const confirm = screen.getByRole('button', { name: 'Confirm use rate limit reset' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onConsumeReset).toHaveBeenCalledOnce()
    expect(onConsumeReset).toHaveBeenCalledWith(
      'codex',
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      undefined,
    )
    const key = onConsumeReset.mock.calls[0]?.[1]
    rejectFirst?.(new Error('Timed out'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Timed out'))

    fireEvent.click(screen.getByRole('button', { name: 'Confirm use rate limit reset' }))
    await waitFor(() => expect(onConsumeReset).toHaveBeenCalledTimes(2))
    expect(onConsumeReset.mock.calls[1]?.[1]).toBe(key)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Still failing'))
  })

  it.each([
    ['nothingToReset', 'Nothing needed a reset.'],
    ['noCredit', 'No reset is available.'],
    ['alreadyRedeemed', 'This reset was already used.'],
  ] as const)('explains a %s consume outcome', async (outcome, message) => {
    const onConsumeReset = vi.fn(async () => ({ outcome }))
    render(limits(resetState, () => {}, onConsumeReset))

    fireEvent.click(screen.getByRole('button', { name: 'Use rate limit reset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm use rate limit reset' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message))
    expect(screen.getByRole('button', { name: 'Use rate limit reset' })).toBeTruthy()
  })
})
