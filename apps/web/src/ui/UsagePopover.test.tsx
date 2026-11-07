// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AccountId } from '@harness/contracts'
import type { AccountLimitsState } from './AccountLimits.js'
import { UsagePopover } from './UsagePopover.js'

afterEach(cleanup)

const tokens = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
}

function ready(
  provider: 'codex' | 'claude-code',
  limits: Array<{
    label: string
    usedPercent: number
    resetsAt?: number
    windowMinutes?: number
    valueLabel?: string
  }>,
  accountId?: string,
): AccountLimitsState {
  return {
    status: 'ready',
    provider,
    ...(accountId === undefined ? {} : { accountId: accountId as AccountId }),
    summary: {
      session: tokens,
      today: tokens,
      limits,
      limitSource: { provider, status: 'ready', limits },
    },
  }
}

function popover(
  states: AccountLimitsState[],
  overrides: Partial<Parameters<typeof UsagePopover>[0]> = {},
) {
  const props = {
    states,
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onOpenHistory: vi.fn(),
    ...overrides,
  }
  render(<UsagePopover {...props} />)
  return props
}

describe('UsagePopover', () => {
  it('draws one large bar per window with what is left and when it resets', () => {
    const now = Date.now()
    popover([
      ready('claude-code', [
        { label: 'Session', usedPercent: 38, resetsAt: now + 3 * 3_600_000 + 12 * 60_000 },
        { label: 'Weekly', usedPercent: 90, resetsAt: now + 3 * 86_400_000 },
      ]),
    ])
    const region = screen.getByRole('region', { name: 'Claude Code' })
    const session = within(region).getByRole('progressbar', { name: 'Claude Code Session left' })
    expect(session.getAttribute('aria-valuenow')).toBe('62')
    const sessionRow = session.closest<HTMLElement>('.usage-pop__limit')!
    expect(sessionRow.style.getPropertyValue('--left')).toBe('0.62')
    expect(sessionRow.hasAttribute('data-low')).toBe(false)
    expect(sessionRow.querySelector('.usage-pop__figure')?.textContent).toBe('62%')
    expect(sessionRow.querySelector('.usage-pop__figure-unit')?.textContent).toBe('left')
    expect(within(sessionRow).getByText(/^Resets in 3h 1[12]m$/)).toBeTruthy()
    // An allowance nearly spent turns the error colour.
    const weekly = within(region).getByRole('progressbar', { name: 'Claude Code Weekly left' })
    expect(weekly.closest('.usage-pop__limit')?.hasAttribute('data-low')).toBe(true)
  })

  it('marks the even pace and leaves the reset off an untouched window', () => {
    const now = Date.now()
    popover([
      ready('codex', [
        { label: '5 hours', usedPercent: 20, resetsAt: now + 150 * 60_000, windowMinutes: 300 },
        { label: '7 days', usedPercent: 0, resetsAt: now + 86_400_000 },
      ]),
    ])
    const paced = screen.getByRole('progressbar', { name: 'Codex 5 hours left' })
    // Half the window is still ahead; the clock moves a little while the test renders.
    const pace = Number.parseFloat(paced.querySelector<HTMLElement>('.usage-pop__pace')!.style.left)
    expect(pace).toBeCloseTo(50, 1)
    const full = screen.getByRole('progressbar', { name: 'Codex 7 days left' })
    expect(full.closest('.usage-pop__limit')?.querySelector('.usage-pop__reset')).toBeNull()
  })

  it('shows a reported value that is not a share as text, without a bar', () => {
    popover([ready('codex', [{ label: 'Credits', usedPercent: 0, valueLabel: '$12.40' }])])
    expect(screen.getByText('$12.40')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('names each account when a provider shows more than one', () => {
    popover(
      [
        ready('claude-code', [{ label: 'Session', usedPercent: 10 }]),
        ready('claude-code', [{ label: 'Session', usedPercent: 70 }], 'work'),
      ],
      { accountLabel: (_provider, accountId) => (accountId === 'work' ? 'Work' : 'Personal') },
    )
    expect(screen.getByRole('region', { name: 'Claude Code · Personal' })).toBeTruthy()
    expect(
      screen.getByRole('progressbar', { name: 'Claude Code · Work Session left' }),
    ).toBeTruthy()
  })

  it('keeps a source being checked as an empty track and offers Retry once a read fails', () => {
    const onRetry = vi.fn()
    popover(
      [
        { status: 'loading', provider: 'codex' },
        { status: 'error', provider: 'claude-code', message: 'Network down.' },
      ],
      { onRetry },
    )
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(codex.getAttribute('aria-busy')).toBe('true')
    expect(within(codex).getByText('Checking…')).toBeTruthy()
    expect(codex.querySelector('.usage-pop__bar.is-checking')).not.toBeNull()
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('Unavailable')).toBeTruthy()
    fireEvent.click(within(claude).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('claude-code')
    // The refresh does not ask again while a source is still being read.
    const refresh = screen.getByRole('button', { name: 'Refresh plan limits' })
    expect(refresh.getAttribute('aria-disabled')).toBe('true')
  })

  it('leaves out a provider without plan limits and says so when none remain', () => {
    const onOpenHistory = vi.fn()
    popover(
      [
        {
          status: 'ready',
          provider: 'codex',
          summary: {
            session: tokens,
            today: tokens,
            limits: [],
            limitSource: { provider: 'codex', status: 'unavailable', reason: 'unsupported' },
          },
        },
      ],
      { onOpenHistory },
    )
    expect(screen.queryByRole('region', { name: 'Codex' })).toBeNull()
    expect(screen.getByText('No provider reports plan limits yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Usage history' }))
    expect(onOpenHistory).toHaveBeenCalledOnce()
  })

  it('asks the server to read on-view sources once, and lands focus on itself', () => {
    const release = vi.fn()
    const onShow = vi.fn(() => release)
    popover([ready('codex', [{ label: '7 days', usedPercent: 50 }])], { onShow })
    expect(onShow).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Usage' }))
    cleanup()
    expect(release).toHaveBeenCalledOnce()
  })
})
