// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageSheet } from './UsageSheet.js'
import type { ProviderSheet, SheetAccount } from './usage-sheets.js'

afterEach(cleanup)

const NOW = Date.UTC(2026, 9, 18, 10)

function account(key: string, label: string, values: Partial<SheetAccount>): SheetAccount {
  return {
    key,
    label,
    sessions: 0,
    tokens: 0,
    value: 0,
    limits: { rows: [], retryable: false },
    ...values,
  }
}

function sheetWith(accounts: SheetAccount[]): ProviderSheet {
  return {
    provider: 'codex',
    name: 'Codex',
    sessions: 12,
    tokens: 4_000,
    value: 40,
    activeDays: 2,
    slots: [
      { tokens: 1_000, value: 10 },
      { tokens: 3_000, value: 30 },
    ],
    empty: false,
    models: [],
    accounts,
  }
}

function renderSheet(sheet: ProviderSheet, onRetry = vi.fn()) {
  render(
    <UsageSheet
      sheet={sheet}
      index={0}
      axis={{ slots: ['Oct 17', 'Oct 18'], ticks: [], start: 'Oct 17', end: 'Today' }}
      unit="day"
      emptyText={undefined}
      now={NOW}
      onRetry={onRetry}
    />,
  )
  return screen.getByRole('region', { name: 'Codex' })
}

describe('usage sheet', () => {
  it('lists one account’s limits as the plan limits, without naming the account', () => {
    const codex = renderSheet(
      sheetWith([
        account('codex', 'Codex', {
          tokens: 4_000,
          limits: { rows: [{ label: 'Weekly', left: 60, state: 'ok' }], retryable: false },
        }),
      ]),
    )

    const limits = within(codex).getByRole('group', { name: 'Plan limits' })
    expect(within(limits).getByRole('progressbar', { name: 'Codex Weekly left' })).toBeTruthy()
    expect(within(codex).queryByRole('group', { name: 'Accounts' })).toBeNull()
  })

  it('lists each account with its share and its own limits under it', () => {
    const onRetry = vi.fn()
    const codex = renderSheet(
      sheetWith([
        account('work', 'Work', {
          tokens: 3_000,
          value: 30,
          limits: { rows: [{ label: 'Weekly', left: 10, state: 'low' }], retryable: false },
        }),
        account('home', 'Home', {
          tokens: 1_000,
          value: 10,
          limits: { rows: [{ label: 'Weekly', left: 90, state: 'ok' }], retryable: false },
        }),
        account('team', 'Team', {
          limits: {
            rows: [],
            status: { label: 'Unavailable', detail: 'offline' },
            retryable: true,
          },
        }),
      ]),
      onRetry,
    )

    expect(within(codex).queryByRole('group', { name: 'Plan limits' })).toBeNull()
    const accounts = within(codex).getByRole('group', { name: 'Accounts' })
    const lines = [...accounts.querySelectorAll('.usage-sheet__line')].map((line) =>
      [...line.children].map((cell) => cell.textContent).join(' | '),
    )
    expect(lines).toEqual([
      'Work | 3K tokens · $30.00',
      'Weekly | 10% left',
      'Home | 1K tokens · $10.00',
      'Weekly | 90% left',
      'Team | No sessions',
      'Unavailable | offline | Retry',
    ])
    expect(
      within(accounts).getByRole('progressbar', { name: 'Codex Work Weekly left' }),
    ).toBeTruthy()
    fireEvent.click(within(accounts).getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledWith('codex')
  })
})
