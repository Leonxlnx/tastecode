// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountLimits, type AccountLimitsState } from './AccountLimits.js'

afterEach(() => {
  cleanup()
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
  ) => Promise<ResultOf<'usage.consumeReset'>>,
) {
  return <AccountLimits states={[state]} onRetry={onRetry} onConsumeReset={onConsumeReset} />
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
    expect(within(api).getByText('$8.24')).toBeTruthy()
    expect(within(api).getByRole('alert').textContent).toContain('Last known values')
  })

  it('distinguishes loading from an empty successful response', () => {
    const view = render(limits({ status: 'loading', provider: 'codex' }))
    expect(screen.getByRole('status').textContent).toContain('Checking plan limits')
    expect(screen.getByRole('region', { name: 'Codex' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Plan limits' }))
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

    const epoch = screen.getByText('Epoch').closest('.account-menu__limit')
    const farFuture = screen.getByText('Far future').closest('.account-menu__limit')
    expect(epoch).not.toBeNull()
    expect(farFuture).not.toBeNull()
    expect(within(epoch as HTMLElement).getByText(/^Resets .*19(?:69|70)$/)).toBeTruthy()
    expect(within(farFuture as HTMLElement).getByText('Reset time unavailable.')).toBeTruthy()
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

    expect(screen.getByText('58% left')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Last known values are still shown')
    expect(screen.getByRole('alert').textContent).toContain('Temporary connection failure')
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    expect(document.activeElement).toBe(retry)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Plan limits' }))

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
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Plan limits' }))
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
