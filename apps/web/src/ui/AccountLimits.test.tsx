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

function openUsage() {
  const trigger = screen.getByRole('button', { name: /^Usage,/ })
  fireEvent.click(trigger)
  return trigger
}

function dispatchTransitionEnd(element: Element, propertyName: string) {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { configurable: true, value: propertyName })
  element.dispatchEvent(event)
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
  it('keeps provider details behind one compact usage row', () => {
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

    const trigger = screen.getByRole('button', { name: 'Usage, 88% left' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Codex' })).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: 'Grok' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Codex' })).toBeTruthy()
    const details = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(details?.getAttribute('data-open')).toBe('true')

    fireEvent.click(trigger)
    expect(details?.getAttribute('data-open')).toBe('false')
    expect(details?.getAttribute('aria-hidden')).toBe('true')
    expect(details?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('region', { name: 'Codex' })).toBeNull()

    act(() => dispatchTransitionEnd(details!, 'grid-template-rows'))
    expect(details?.isConnected).toBe(true)

    act(() => dispatchTransitionEnd(details!, 'opacity'))
    expect(details?.isConnected).toBe(false)
  })

  it('reverses an unreveal without unmounting its details', () => {
    render(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: summary([{ label: 'Weekly', usedPercent: 30 }]),
      }),
    )

    const trigger = openUsage()
    const details = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    fireEvent.click(trigger)
    fireEvent.click(trigger)

    expect(details?.getAttribute('data-open')).toBe('true')
    act(() => dispatchTransitionEnd(details!, 'opacity'))
    expect(details?.isConnected).toBe(true)
    expect(screen.getByRole('region', { name: 'Codex' })).toBeTruthy()
  })

  it('keeps ordered provider states and retries their source independently', () => {
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
    openUsage()

    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Codex', 'Claude Code', 'OpenCode', 'Cursor', 'API connection'])
    expect(within(screen.getByRole('region', { name: 'Codex' })).getByText(/Checking/)).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: 'Claude Code' })).getByText(
        'No plan limits reported.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()

    const openCode = screen.getByRole('region', { name: 'OpenCode' })
    expect(within(openCode).getByRole('alert').textContent).not.toContain('Last known values')
    fireEvent.click(within(openCode).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('opencode')

    const cursor = screen.getByRole('region', { name: 'Cursor' })
    expect(within(cursor).getByText('75% left')).toBeTruthy()
    expect(within(cursor).getByRole('status').textContent).toContain('Last known values')

    const api = screen.getByRole('region', { name: 'API connection' })
    const apiValue = within(api).getByText('$8.24')
    expect(apiValue.classList.contains('account-menu__limit-value')).toBe(true)
    expect(within(api).getByRole('alert').textContent).toContain('Last known values')
  })

  it('distinguishes loading from an empty successful response', () => {
    const view = render(limits({ status: 'loading', provider: 'codex' }))
    const trigger = openUsage()
    expect(screen.getByRole('status').textContent).toContain('Checking plan limits')
    expect(screen.getByRole('region', { name: 'Codex' })).toBeTruthy()
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('region', { name: 'Plan limits' }).getAttribute('aria-busy')).toBe(
      'true',
    )

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
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('No plan limits reported.')).toBeTruthy()

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
    openUsage()

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
      expect(screen.queryByText('No plan limits reported.')).toBeNull()
      expect(screen.queryByText(/aren’t available/)).toBeNull()
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
    openUsage()

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
    openUsage()

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

  it('updates the expiry warning while open and clears its timer on close', () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 8, 13, 12)
    vi.setSystemTime(now)
    render(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: summary([{ ...resetLimit, resetCredits: [{ expiresAt: now + 86_400_000 }] }]),
      }),
    )
    const trigger = openUsage()
    const time = screen.getByRole('list').querySelector('time')!
    expect(time.hasAttribute('data-expiring-soon')).toBe(false)

    act(() => vi.advanceTimersByTime(60_000))
    expect(time.hasAttribute('data-expiring-soon')).toBe(true)
    const details = document.getElementById(trigger.getAttribute('aria-controls')!)!
    fireEvent.click(trigger)
    act(() => dispatchTransitionEnd(details, 'opacity'))
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
    openUsage()
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
    const trigger = openUsage()

    expect(
      within(screen.getByRole('region', { name: 'Claude Code' })).getByText('58% left'),
    ).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Last known values are still shown')
    expect(screen.getByRole('alert').textContent).toContain('Temporary connection failure')
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    expect(document.activeElement).toBe(retry)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)

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
    expect(document.activeElement).toBe(trigger)
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
    openUsage()

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
    openUsage()

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
    openUsage()
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
    openUsage()

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
    openUsage()

    fireEvent.click(screen.getByRole('button', { name: 'Use rate limit reset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm use rate limit reset' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message))
    expect(screen.getByRole('button', { name: 'Use rate limit reset' })).toBeTruthy()
  })
})
