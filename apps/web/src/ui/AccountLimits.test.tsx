// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

function limits(state: AccountLimitsState, onRetry = () => {}) {
  return <AccountLimits state={state} onRetry={onRetry} />
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
    ).toEqual(['Codex', 'Claude Code', 'Grok', 'OpenCode', 'Cursor', 'API connection'])
    expect(within(screen.getByRole('region', { name: 'Codex' })).getByText(/Checking/)).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: 'Claude Code' })).getByText(
        'No plan limits reported.',
      ),
    ).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: 'Grok' })).getByText(/aren’t available/),
    ).toBeTruthy()

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
    expect(screen.getByText(/aren’t available/)).toBeTruthy()

    view.rerender(limits({ status: 'error', provider: 'grok', message: 'Offline' }))
    expect(screen.getByRole('region', { name: 'Grok' })).toBeTruthy()
  })

  it('labels each source and keeps unavailable separate from ready values', () => {
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
    const grok = screen.getByRole('region', { name: 'Grok' })
    expect(within(grok).getByText(/aren’t available/)).toBeTruthy()

    for (const emptySummary of [
      { ...summary(), limitSource: { provider: 'grok', status: 'unavailable' } as const },
      summary(),
    ]) {
      view.rerender(
        limits({ status: 'error', provider: 'grok', message: 'Offline', summary: emptySummary }),
      )
      expect(screen.getByRole('alert').textContent).not.toContain('Last known values')
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
      limits({ status: 'loading', provider: 'claude-code', summary: summary() }, onRetry),
    )
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Plan limits' }))
  })
})
