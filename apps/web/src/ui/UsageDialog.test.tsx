// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AccountId, ResultOf, UsageHistoryRange } from '@harness/contracts'
import type { Transport } from '../transport.js'
import type { AccountLimitsState } from './AccountLimits.js'
import { UsageDialog } from './UsageDialog.js'
import { historyResult } from './usage/usage-history.fixture.js'

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

function transportOf(result: (range: UsageHistoryRange) => ResultOf<'usage.history'>) {
  const request = vi.fn(async (_method: string, params: { range: UsageHistoryRange }) =>
    result(params.range),
  )
  return { request, transport: { request } as unknown as Transport }
}

function dialog(
  states: AccountLimitsState[],
  overrides: Partial<Parameters<typeof UsageDialog>[0]> = {},
) {
  const props = {
    transport: transportOf(historyResult).transport,
    states,
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onOpenHistory: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<UsageDialog {...props} />)
  return props
}

describe('UsageDialog', () => {
  it('opens over the whole window as a modal on its limits', () => {
    dialog([ready('codex', [{ label: '7 days', usedPercent: 50 }])])
    const usage = screen.getByRole('dialog', { name: 'Usage' })
    expect(usage.getAttribute('aria-modal')).toBe('true')
    expect(usage.closest('.sheet')?.parentElement).toBe(document.body)
    expect(screen.getByRole('button', { name: 'Limits' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(usage)
  })

  it('draws one long bar per window with what is left and when it resets', () => {
    const now = Date.now()
    dialog([
      ready('claude-code', [
        { label: 'Session', usedPercent: 38, resetsAt: now + 3 * 3_600_000 + 12 * 60_000 },
        { label: 'Weekly', usedPercent: 90, resetsAt: now + 3 * 86_400_000 },
      ]),
    ])
    const region = screen.getByRole('region', { name: 'Claude Code' })
    const session = within(region).getByRole('progressbar', { name: 'Claude Code Session left' })
    expect(session.getAttribute('aria-valuenow')).toBe('62')
    const row = session.closest<HTMLElement>('.usage-dialog__row')!
    expect(row.style.getPropertyValue('--left')).toBe('0.62')
    expect(row.querySelector('.usage-dialog__figure')?.textContent).toBe('62%')
    expect(within(row).getByText(/^Resets in 3h 1[12]m$/)).toBeTruthy()
    // The window with the least left is named under the title.
    expect(screen.getByText('Lowest: Claude Code · Weekly')).toBeTruthy()
    const weekly = within(region).getByRole('progressbar', { name: 'Claude Code Weekly left' })
    expect(weekly.closest('.usage-dialog__row')?.hasAttribute('data-low')).toBe(true)
  })

  it('marks the even pace and calls an untouched window untouched', () => {
    const now = Date.now()
    dialog([
      ready('codex', [
        { label: '5 hours', usedPercent: 20, resetsAt: now + 150 * 60_000, windowMinutes: 300 },
        { label: '7 days', usedPercent: 0, resetsAt: now + 86_400_000 },
      ]),
    ])
    const paced = screen.getByRole('progressbar', { name: 'Codex 5 hours left' })
    const pace = Number.parseFloat(
      paced.querySelector<HTMLElement>('.usage-dialog__pace')!.style.left,
    )
    expect(pace).toBeCloseTo(50, 0)
    const full = screen.getByRole('progressbar', { name: 'Codex 7 days left' })
    expect(
      within(full.closest<HTMLElement>('.usage-dialog__row')!).getByText('Untouched'),
    ).toBeTruthy()
  })

  it('gives a provider with several accounts one panel: the pool, then a line per account', () => {
    const now = Date.now()
    dialog(
      [
        ready('claude-code', [
          { label: 'Session', usedPercent: 10, resetsAt: now + 3_600_000 },
          { label: 'Weekly', usedPercent: 40 },
        ]),
        ready('codex', [{ label: '7 days', usedPercent: 30 }]),
        // A plan without a session window, and nearly spent.
        ready('claude-code', [{ label: 'Weekly', usedPercent: 97 }], 'work'),
      ],
      {
        accountLabel: (_provider, accountId) => (accountId === 'work' ? 'Work' : 'Personal'),
        pools: [
          {
            provider: 'claude-code',
            unit: 'Pro',
            recommended: 'default' as AccountId,
            accounts: [
              {
                accountId: 'default' as AccountId,
                label: 'Personal',
                plan: 'max',
                status: 'ready',
                windows: [],
                atLimit: false,
              },
              {
                accountId: 'work' as AccountId,
                label: 'Work',
                plan: 'max x20',
                status: 'ready',
                windows: [],
                atLimit: false,
              },
            ],
            windows: [
              {
                id: 'session',
                label: 'Session',
                kind: 'session',
                accounts: 1,
                capacity: 5,
                remaining: 4.5,
              },
            ],
          },
        ],
      },
    )
    // Claude Code's accounts stay together in one panel, ahead of Codex.
    expect(
      Array.from(document.querySelectorAll('.usage-dialog__source')).map((source) =>
        source.getAttribute('aria-label'),
      ),
    ).toEqual(['Claude Code', 'Codex'])
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('2 accounts')).toBeTruthy()
    const pool = within(claude).getByRole('progressbar', {
      name: 'Claude Code Session left, all accounts',
    })
    expect(pool.getAttribute('aria-valuenow')).toBe('90')
    expect(within(claude).getByText('4.5× of 5× Pro left')).toBeTruthy()

    const table = within(claude).getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Account', 'Session', 'Weekly'])
    const personal = within(table).getByRole('rowheader', { name: /Personal/ })
    expect(within(personal).getByText('Recommended')).toBeTruthy()
    expect(within(personal).getByText('Max')).toBeTruthy()
    const work = within(table).getByRole('rowheader', { name: /Work/ }).closest('tr')!
    // The Work plan has no session window: a dash, not an empty bar.
    expect(within(work).getByTitle('This plan has no such window').textContent).toBe('—')
    const weekly = within(work).getByRole('progressbar', { name: 'Claude Code · Work Weekly left' })
    expect(weekly.getAttribute('aria-valuenow')).toBe('3')
    expect(weekly.closest('.usage-dialog__cell')?.hasAttribute('data-low')).toBe(true)
    // The lowest window names its account when the provider has several.
    expect(screen.getByText('Lowest: Claude Code · Work · Weekly')).toBeTruthy()
  })

  it('keeps a source being checked as an empty track and offers Retry once a read fails', () => {
    const onRetry = vi.fn()
    dialog(
      [
        { status: 'loading', provider: 'codex' },
        { status: 'error', provider: 'claude-code', message: 'Network down.' },
      ],
      { onRetry },
    )
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText('Checking…')).toBeTruthy()
    expect(codex.querySelector('.usage-dialog__bar.is-checking')).not.toBeNull()
    const claude = screen.getByRole('region', { name: 'Claude Code' })
    expect(within(claude).getByText('Unavailable')).toBeTruthy()
    fireEvent.click(within(claude).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('claude-code')
    // The refresh does not ask again while a source is still being read.
    const refresh = screen.getByRole('button', { name: 'Refresh plan limits' })
    expect(refresh.getAttribute('aria-disabled')).toBe('true')
  })

  it('asks the server to read on-view sources once and releases them on close', () => {
    const release = vi.fn()
    const onShow = vi.fn(() => release)
    dialog([ready('codex', [{ label: '7 days', usedPercent: 50 }])], { onShow })
    expect(onShow).toHaveBeenCalledOnce()
    cleanup()
    expect(release).toHaveBeenCalledOnce()
  })

  it('closes with Escape, the close button and the scrim, and leads on to the history', () => {
    const props = dialog([ready('codex', [{ label: '7 days', usedPercent: 50 }])])
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Usage' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close usage' }))
    expect(props.onClose).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: /Full history in Settings/ }))
    expect(props.onOpenHistory).toHaveBeenCalledOnce()
  })

  it('shows each provider and its models as token bars for the chosen period', async () => {
    const { request, transport } = transportOf(historyResult)
    dialog([], { transport })
    expect(screen.getByText('No signed-in provider reports plan limits yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tokens' }))
    const codex = await screen.findByRole('region', { name: 'Codex' })
    // One model is the provider's whole use, so its row carries the model's name alone.
    expect(
      within(codex)
        .getAllByRole('img')
        .map((bar) => bar.getAttribute('aria-label')),
    ).toEqual(['gpt-5.6-sol: 1.23M tokens'])
    expect(within(codex).getByText('4 sessions')).toBeTruthy()
    const totals = Array.from(document.querySelectorAll('.usage-dialog__total-value'))
    expect(totals.map((total) => total.textContent)).toEqual(['1.23M', '$12.34', '$4.56'])
    expect(request).toHaveBeenLastCalledWith(
      'usage.history',
      expect.objectContaining({ range: '7d' }),
    )
    fireEvent.click(screen.getByRole('button', { name: '30 days' }))
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    await screen.findByRole('region', { name: 'Codex' })
    expect(request).toHaveBeenLastCalledWith(
      'usage.history',
      expect.objectContaining({ range: '30d' }),
    )
  })
})
