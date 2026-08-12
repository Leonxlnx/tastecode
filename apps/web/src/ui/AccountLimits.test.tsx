// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountLimits, type AccountLimitsState } from './AccountLimits.js'

afterEach(cleanup)

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

describe('account limits', () => {
  it('distinguishes loading from an empty successful response', () => {
    const view = render(
      <AccountLimits state={{ status: 'loading', provider: 'codex' }} onRetry={() => {}} />,
    )
    expect(screen.getByRole('status').textContent).toContain('Checking plan limits')
    expect(screen.getByRole('region', { name: 'Plan limits' }).getAttribute('aria-busy')).toBe(
      'true',
    )

    view.rerender(
      <AccountLimits
        state={{ status: 'ready', provider: 'codex', summary: summary() }}
        onRetry={() => {}}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('No plan limits reported.')).toBeTruthy()
  })

  it('labels multiple sources and keeps unavailable separate from ready values', () => {
    const state: AccountLimitsState = {
      status: 'ready',
      provider: 'codex',
      summary: {
        ...summary(),
        limitSources: [
          {
            provider: 'codex',
            status: 'ready',
            limits: [
              { label: 'Weekly', usedPercent: 85 },
              { label: 'Credits', usedPercent: 0, valueLabel: '$12.40' },
            ],
          },
          { provider: 'grok', status: 'unavailable' },
        ],
      },
    }
    render(<AccountLimits state={state} onRetry={() => {}} />)

    const codex = screen.getByRole('region', { name: 'Codex' })
    const grok = screen.getByRole('region', { name: 'Grok' })
    expect(within(codex).getByText('15% left')).toBeTruthy()
    expect(within(codex).getByText('$12.40')).toBeTruthy()
    expect(within(grok).getByText(/aren’t available/)).toBeTruthy()
    const bar = within(codex).getByRole('progressbar', { name: 'Codex Weekly left' })
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('15%')
  })

  it('preserves usable values through a failed refresh and retries', () => {
    const onRetry = vi.fn()
    render(
      <AccountLimits
        state={{
          status: 'error',
          provider: 'claude-code',
          message: 'Temporary connection failure',
          summary: summary([{ label: 'Session', usedPercent: 42 }]),
        }}
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText('58% left')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Last known values are still shown')
    expect(screen.getByRole('alert').textContent).toContain('Temporary connection failure')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
