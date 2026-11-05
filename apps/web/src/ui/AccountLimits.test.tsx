// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ProviderAccount, ResultOf } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { poolsOf } from '../account-pool.js'
import { AccountLimits, type AccountLimitsState, summaryLimit } from './AccountLimits.js'
import { dateTimeText } from './usage/usage-format.js'

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

/** Opens a closed source by its heading, so every row it reports is on screen. */
function open(name: string) {
  const toggle = within(screen.getByRole('region', { name })).getByRole('button', { name })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
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

  it('names each account of a provider shown more than once, and asks for that account', async () => {
    const onRetry = vi.fn()
    const onConsumeReset = vi.fn(async () => ({ outcome: 'reset' as const }))
    const label = (_provider: string, accountId: string | undefined) =>
      accountId === 'work-1a2b3c' ? 'Work' : 'Personal'
    const view = render(
      <AccountLimits
        states={[
          {
            status: 'ready',
            provider: 'codex',
            accountId: 'work-1a2b3c',
            summary: {
              ...summary(),
              limitSource: {
                provider: 'codex',
                accountId: 'work-1a2b3c',
                status: 'ready',
                limits: [resetLimit],
              },
            },
          },
          {
            status: 'error',
            provider: 'codex',
            message: 'Codex did not answer.',
          },
          {
            status: 'ready',
            provider: 'grok',
            summary: summary([{ label: 'Weekly', usedPercent: 10 }]),
          },
        ]}
        accountLabel={label}
        onRetry={onRetry}
        onConsumeReset={onConsumeReset}
      />,
    )

    // Two accounts of one provider sit under its name, each a line that opens to its limits.
    const codex = screen.getByRole('group', { name: 'Codex' })
    // Beside a provider with several accounts, a provider with one reads the same way: a line.
    const grok = screen.getByRole('group', { name: 'Grok' })
    expect(within(grok).getByText('Personal')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()

    // An account that could not be read says so on its line, with Retry beside it.
    expect(within(codex).getByText('Unavailable')).toBeTruthy()
    fireEvent.click(within(codex).getByRole('button', { name: 'Retry Personal' }))
    expect(onRetry).toHaveBeenCalledWith('codex')

    const work = within(codex).getByRole('button', { name: 'Work, Rate limit resets 1 available' })
    expect(work.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Codex · Work' })).toBeNull()
    fireEvent.click(work)
    expect(work.getAttribute('aria-expanded')).toBe('true')
    const workLimits = screen.getByRole('region', { name: 'Codex · Work' })
    fireEvent.click(within(workLimits).getByRole('button', { name: 'Use rate limit reset' }))
    fireEvent.click(
      within(workLimits).getByRole('button', { name: 'Confirm use rate limit reset' }),
    )
    await waitFor(() =>
      expect(onConsumeReset).toHaveBeenCalledWith(
        'codex',
        expect.any(String),
        undefined,
        'work-1a2b3c',
      ),
    )

    // A further account shown alone still says whose limits these are.
    view.rerender(
      <AccountLimits
        states={[
          {
            status: 'ready',
            provider: 'codex',
            accountId: 'work-1a2b3c',
            summary: summary([{ label: 'Weekly', usedPercent: 50 }]),
          },
        ]}
        accountLabel={label}
        onRetry={onRetry}
      />,
    )
    const alone = screen.getByRole('region', { name: 'Codex · Work' })
    expect(screen.queryByText(/work-1a2b3c/)).toBeNull()
    // Its account heading opens and closes its rows like a provider's.
    expect(within(alone).getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('closes each source to its heading and the window with the least left, and opens it to every row', async () => {
    const now = Date.UTC(2026, 10, 2, 0, 30)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const onConsumeReset = vi.fn(async () => ({ outcome: 'reset' as const }))
    render(
      <AccountLimits
        states={[
          {
            status: 'ready',
            provider: 'codex',
            summary: summary([
              {
                label: 'Weekly',
                usedPercent: 5,
                windowMinutes: 10_080,
                resetsAt: now + 3 * 3_600_000,
              },
              { label: 'Credits', usedPercent: 0, valueLabel: '$1,724.24 · 43,106 credits' },
              {
                ...resetLimit,
                valueLabel: '2 available',
                resetCredits: [
                  { id: 'later', expiresAt: now + 3 * 86_400_000 },
                  { id: 'soon', expiresAt: now + 2 * 86_400_000 },
                ],
              },
            ]),
          },
          {
            status: 'ready',
            provider: 'cursor',
            summary: summary([
              { label: 'Included', usedPercent: 24 },
              { label: 'Auto', usedPercent: 90 },
              { label: 'API', usedPercent: 0 },
            ]),
          },
        ]}
        onRetry={() => {}}
        onConsumeReset={onConsumeReset}
      />,
    )

    // Closed: the heading and one line, its bar between label and value, nothing to spend.
    const codex = screen.getByRole('region', { name: 'Codex' })
    const toggle = within(codex).getByRole('button', { name: 'Codex' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.hasAttribute('aria-controls')).toBe(false)
    expect(toggle.closest('h3')).not.toBeNull()
    const rows = codex.querySelectorAll<HTMLElement>('.account-menu__limit')
    expect(rows).toHaveLength(1)
    const line = rows[0]!
    expect(line.classList.contains('is-inline')).toBe(true)
    expect(line.textContent).toBe('Weekly95% left')
    const bar = within(line).getByRole('progressbar', { name: 'Codex Weekly left' })
    expect(bar.parentElement?.classList.contains('account-menu__limit-row')).toBe(true)
    // The reset time moves to hover instead of a line of its own.
    expect(line.title).toMatch(/^Resets in 3h · /)
    expect(line.querySelector('.account-menu__limit-reset')).toBeNull()
    expect(within(codex).queryByText(/Credits|credits/)).toBeNull()
    expect(within(codex).queryByRole('button', { name: 'Use rate limit reset' })).toBeNull()

    // The share with the least left stands for its source, not the first one.
    const cursor = screen.getByRole('region', { name: 'Cursor' })
    const cursorLine = cursor.querySelector<HTMLElement>('.account-menu__limit')!
    expect(cursorLine.textContent).toBe('Auto10% left')
    expect(cursorLine.hasAttribute('data-low')).toBe(true)

    // Open: every row as before, with the resets to spend; focus stays on the heading.
    toggle.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(codex.contains(body)).toBe(true)
    expect(document.activeElement).toBe(toggle)
    expect(body.querySelector('.account-menu__limit.is-inline')).toBeNull()
    expect(within(body).getByText('Resets in 3h')).toBeTruthy()
    expect(within(body).getByText('$1,724.24 · 43,106 credits')).toBeTruthy()
    const uses = within(body).getAllByRole('button', { name: 'Use rate limit reset' })
    expect(uses).toHaveLength(2)
    fireEvent.click(uses[0]!)
    fireEvent.click(within(body).getByRole('button', { name: 'Confirm use rate limit reset' }))
    await waitFor(() =>
      expect(onConsumeReset).toHaveBeenCalledWith('codex', expect.any(String), 'soon'),
    )

    // Closing returns to the one line; the other source never moved.
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(codex.querySelectorAll('.account-menu__limit')).toHaveLength(1)
    expect(
      within(cursor).getByRole('button', { name: 'Cursor' }).getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('stands a source for its share with the least left, and keeps a heading without values plain', () => {
    expect(summaryLimit([])).toBeUndefined()
    const credits = { label: 'Credits', usedPercent: 0, valueLabel: '$8.24' }
    expect(summaryLimit([credits])).toBe(credits)
    const session = { label: 'Session', usedPercent: 40 }
    const weekly = { label: 'Weekly', usedPercent: 60 }
    // Rounds to the same 40% left: the first of equals stays.
    const other = { label: 'Other weekly', usedPercent: 60.2 }
    expect(summaryLimit([credits, session, weekly, other])).toBe(weekly)

    render(
      <AccountLimits
        states={[
          { status: 'error', provider: 'claude-code', message: 'Offline' },
          { status: 'loading', provider: 'grok' },
        ]}
        onRetry={() => {}}
      />,
    )
    for (const name of ['Claude Code', 'Grok']) {
      const region = screen.getByRole('region', { name })
      expect(within(region).queryByRole('button', { name })).toBeNull()
      expect(region.querySelector('[aria-expanded]')).toBeNull()
      expect(region.classList.contains('is-closed')).toBe(false)
    }
  })

  it('starts every account closed, each on one line with what it has left at a glance', () => {
    render(
      <AccountLimits
        states={[
          {
            status: 'ready',
            provider: 'claude-code',
            accountId: 'personal-1a2b3c',
            summary: summary([
              { label: 'Session', usedPercent: 100, windowMinutes: 300 },
              { label: 'Weekly', usedPercent: 98, windowMinutes: 10_080 },
            ]),
          },
          {
            status: 'ready',
            provider: 'claude-code',
            summary: summary([
              { label: 'Session', usedPercent: 73, windowMinutes: 300 },
              { label: 'Weekly', usedPercent: 40, windowMinutes: 10_080 },
              { label: 'Fable weekly', usedPercent: 0, windowMinutes: 10_080 },
            ]),
          },
        ]}
        accountLabel={(_provider, accountId) => (accountId ? 'Personal' : 'Default')}
        activeAccount={() => 'personal-1a2b3c'}
        onRetry={() => {}}
      />,
    )
    // Even the account new chats start on is one line until opened.
    const personal = screen.getByRole('button', {
      name: 'Personal, Session 0% left, Weekly 2% left',
    })
    expect(personal.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Claude Code · Personal' })).toBeNull()

    // Closed, an account shows each window once: Session and Weekly, not Fable weekly,
    // as a short bar and its share; the label and reset are on hover.
    const other = screen.getByRole('button', {
      name: 'Default, Session 27% left, Weekly 60% left',
    })
    expect(other.getAttribute('aria-expanded')).toBe('false')
    expect(other.textContent).toBe('DefaultSession 27%Weekly 60%')
    const windows = [...other.querySelectorAll<HTMLElement>('.account-menu__glance-item')]
    expect(windows.map((item) => item.title)).toEqual(['Session: 27% left', 'Weekly: 60% left'])
    fireEvent.click(other)
    const defaultLimits = screen.getByRole('region', { name: 'Claude Code · Default' })
    expect(within(defaultLimits).getByText('100% left')).toBeTruthy()

    // Opening one leaves the other as it was; each closes again to its line.
    fireEvent.click(personal)
    const personalLimits = screen.getByRole('region', { name: 'Claude Code · Personal' })
    expect(within(personalLimits).getByText('0% left')).toBeTruthy()
    expect(within(personalLimits).getByText('2% left')).toBeTruthy()
    fireEvent.click(personal)
    expect(screen.queryByRole('region', { name: 'Claude Code · Personal' })).toBeNull()
  })

  it('sums a provider’s accounts into one pool above them and marks the one to use next', () => {
    const now = Date.now()
    const hour = 3_600_000
    const day = 24 * hour
    const window = (label: string, usedPercent: number, minutes: number, resetsAt: number) => ({
      label,
      usedPercent,
      windowMinutes: minutes,
      resetsAt,
    })
    const states: AccountLimitsState[] = [
      {
        status: 'ready',
        provider: 'claude-code',
        summary: summary([
          window('Session', 40, 300, now + 2 * hour),
          window('Weekly', 30, 10_080, now + 3 * day),
        ]),
      },
      {
        status: 'ready',
        provider: 'claude-code',
        accountId: 'max-1a2b3c',
        summary: summary([
          window('Session', 10, 300, now + 4 * hour),
          window('Weekly', 50, 10_080, now + day),
        ]),
      },
      {
        status: 'ready',
        provider: 'claude-code',
        accountId: 'ultra-1a2b3c',
        summary: summary([window('Weekly', 20, 10_080, now + 5 * day)]),
      },
    ]
    const accounts: ProviderAccount[] = [
      { id: 'default', provider: 'claude-code', label: 'Personal', managed: false, plan: 'Pro' },
      {
        id: 'max-1a2b3c',
        provider: 'claude-code',
        label: 'Work',
        home: 'C:\\accounts\\max',
        managed: true,
        plan: 'Max x5',
      },
      {
        id: 'ultra-1a2b3c',
        provider: 'claude-code',
        label: 'Studio',
        home: 'C:\\accounts\\ultra',
        managed: true,
        plan: 'Max x20',
      },
    ]
    const names = new Map(accounts.map((account) => [account.id, account.label]))
    render(
      <AccountLimits
        states={states}
        accountLabel={(_provider, accountId) => names.get(accountId ?? 'default') ?? 'Account'}
        activeAccount={() => 'default'}
        pools={poolsOf(states, accounts, now)}
        onRetry={() => {}}
      />,
    )

    const pool = screen.getByRole('region', { name: 'Claude Code · All accounts' })
    const group = screen.getByRole('group', { name: 'Claude Code' })
    // The pool comes before every account line.
    expect(group.querySelector('.account-menu__pool, .account-menu__account')).toBe(pool)
    expect(pool.querySelector<HTMLElement>('.account-menu__pool-name')?.title).toBe('3 accounts')

    // Session: Pro and Max (Ultra has no 5-hour window), 5.1 of 6 left.
    const session = within(pool).getByRole('progressbar', {
      name: 'Claude Code Session left, all accounts',
    })
    expect(session.getAttribute('aria-valuenow')).toBe('85')
    expect(session.getAttribute('aria-valuetext')).toBe('85% left, 5.1 of 6× Pro left')
    // One line: the size, the amount, what it counts and the next reset are on hover.
    const sessionTitle = session.closest<HTMLElement>('.account-menu__glance-item')!.title
    expect(sessionTitle).toContain('Session · 6× Pro: 85% left')
    expect(sessionTitle).toContain('5.1× Pro left · 2 of 3 accounts')
    expect(sessionTitle).toMatch(/Personal resets in 2h/)
    // Weekly: 11.2 of 16 left, a segment per account, the soonest reset first.
    const weekly = within(pool).getByRole('progressbar', {
      name: 'Claude Code Weekly left, all accounts',
    })
    expect(weekly.getAttribute('aria-valuenow')).toBe('70')
    const segments = [...weekly.querySelectorAll<HTMLElement>('.account-menu__pool-segment')]
    expect(segments.map((segment) => segment.title.split(':')[0])).toEqual([
      'Work',
      'Personal',
      'Studio',
    ])
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual(['5', '1', '10'])
    const weeklyTitle = weekly.closest<HTMLElement>('.account-menu__glance-item')!.title
    expect(weeklyTitle).toContain('11.2× Pro left')
    expect(weeklyTitle).toMatch(/Work resets /)

    // Work resets its week soonest with room left: it is the one to use next.
    const work = screen.getByRole('button', { name: /^Work, recommended, / })
    expect(within(work).getByText('Recommended')).toBeTruthy()
    expect(screen.getAllByText('Recommended')).toHaveLength(1)
    // A closed line names its plan on hover; the open details name it first.
    expect(work.title).toMatch(/^Max x5 · /)
    expect(within(work).queryByText('Max x5')).toBeNull()
    fireEvent.click(work)
    expect(
      within(screen.getByRole('region', { name: 'Claude Code · Work' })).getByText('Max x5 plan'),
    ).toBeTruthy()
  })

  it('shows no pool without plan sizes, and none for a single account', () => {
    const states: AccountLimitsState[] = [
      {
        status: 'ready',
        provider: 'codex',
        summary: summary([{ label: 'Weekly', usedPercent: 10, windowMinutes: 10_080 }]),
      },
      {
        status: 'ready',
        provider: 'codex',
        accountId: 'work-1a2b3c',
        summary: summary([{ label: 'Weekly', usedPercent: 10, windowMinutes: 10_080 }]),
      },
    ]
    const view = render(
      <AccountLimits states={states} pools={poolsOf(states, [], Date.now())} onRetry={() => {}} />,
    )
    expect(screen.queryByRole('region', { name: /All accounts/ })).toBeNull()
    view.unmount()

    const single = [states[0]!]
    render(
      <AccountLimits
        states={single}
        pools={poolsOf(
          single,
          [{ id: 'default', provider: 'codex', label: 'Default', managed: false, plan: 'Plus' }],
          Date.now(),
        )}
        onRetry={() => {}}
      />,
    )
    expect(screen.queryByRole('region', { name: /All accounts/ })).toBeNull()
    expect(screen.queryByText('Recommended')).toBeNull()
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

  it('refreshes every source from the first heading line, and turns while any reads', () => {
    const onRefresh = vi.fn()
    const weekly = summary([{ label: 'Weekly', usedPercent: 10 }])
    const states: AccountLimitsState[] = [
      { status: 'ready', provider: 'codex', summary: weekly },
      { status: 'ready', provider: 'codex', accountId: 'work-1a2b3c', summary: weekly },
      { status: 'ready', provider: 'grok', summary: weekly },
    ]
    const view = render(<AccountLimits states={states} onRetry={() => {}} onRefresh={onRefresh} />)
    const [refresh, ...others] = screen.getAllByRole('button', { name: 'Refresh plan limits' })
    expect(others).toHaveLength(0)
    const line = refresh!.closest<HTMLElement>('.account-menu__provider-head')!
    expect(within(line).getByRole('heading', { name: 'Codex' })).toBeTruthy()
    fireEvent.click(refresh!)
    expect(onRefresh).toHaveBeenCalledOnce()

    // While a source reads it turns and asks nothing more, keeping focus.
    view.rerender(
      <AccountLimits
        states={[{ ...states[0]!, status: 'loading' }, states[1]!, states[2]!]}
        onRetry={() => {}}
        onRefresh={onRefresh}
      />,
    )
    expect(refresh!.getAttribute('aria-disabled')).toBe('true')
    expect(refresh!.classList.contains('is-busy')).toBe(true)
    fireEvent.click(refresh!)
    expect(onRefresh).toHaveBeenCalledOnce()

    // A provider shown alone carries it at the end of its own heading line.
    view.rerender(<AccountLimits states={[states[2]!]} onRetry={() => {}} onRefresh={onRefresh} />)
    const grok = screen.getByRole('region', { name: 'Grok' })
    const alone = within(grok).getByRole('button', { name: 'Refresh plan limits' })
    expect(alone.getAttribute('aria-disabled')).toBeNull()
    // Without a handler there is no refresh.
    view.rerender(<AccountLimits states={states} onRetry={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Refresh plan limits' })).toBeNull()
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

  it('says a failed source is retrying, then leaves it out once the retries gave up', () => {
    const codex: AccountLimitsState = {
      status: 'ready',
      provider: 'codex',
      summary: summary([{ label: 'Weekly', usedPercent: 29 }]),
    }
    const view = render(
      <AccountLimits
        states={[
          {
            status: 'loading',
            provider: 'grok',
            retry: { attempt: 2, of: 3, message: 'Grok Build did not report its credits.' },
          },
          codex,
        ]}
        onRetry={() => {}}
      />,
    )

    const grok = screen.getByRole('region', { name: 'Grok' })
    const status = statusOf(grok)!
    expect(status.firstChild?.textContent).toBe('Retrying…')
    expect(status.title).toBe(
      'Plan limits couldn’t be loaded. Grok Build did not report its credits. Trying again, 2 of 3.',
    )
    expect(within(grok).queryByRole('button', { name: 'Retry' })).toBeNull()

    view.rerender(
      <AccountLimits
        states={[
          {
            status: 'error',
            provider: 'grok',
            message: 'Grok Build did not report its credits.',
            gaveUp: true,
          },
          codex,
        ]}
        onRetry={() => {}}
      />,
    )
    expect(screen.queryByRole('region', { name: 'Grok' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Codex' })).toBeTruthy()
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
    open('Codex')

    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getByText('15% left')).toBeTruthy()
    expect(within(codex).getByText('$12.40')).toBeTruthy()
    const bar = within(codex).getByRole('progressbar', { name: 'Codex Weekly left' })
    expect(bar.getAttribute('aria-valuenow')).toBe('15')
    const row = bar.closest<HTMLElement>('.account-menu__limit')!
    expect(row.hasAttribute('data-gauge')).toBe(true)
    expect(row.style.getPropertyValue('--left')).toBe('0.15')
    // 15% left is where the card's meter turns red too.
    expect(row.hasAttribute('data-low')).toBe(true)
    const credits = within(codex).getByText('$12.40').closest<HTMLElement>('.account-menu__limit')!
    expect(credits.hasAttribute('data-gauge')).toBe(false)
    expect(credits.hasAttribute('data-low')).toBe(false)
    expect(credits.style.getPropertyValue('--left')).toBe('')

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
              { label: 'Epoch', usedPercent: 10, resetsAt: 0 },
              { label: 'Far future', usedPercent: 10, resetsAt: Number.MAX_SAFE_INTEGER },
            ],
          },
        },
      }),
    )
    open('Codex')

    const epoch = screen.getByText('Epoch').closest('.account-menu__limit')
    const farFuture = screen.getByText('Far future').closest('.account-menu__limit')
    expect(epoch).not.toBeNull()
    expect(farFuture).not.toBeNull()
    // A reset time already past reads as due, in the Usage page's words.
    expect(within(epoch as HTMLElement).getByText('Resets now')).toBeTruthy()
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
    open('Codex')

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
    // The words of a reset line: month and day, then the time, no year this year.
    for (const [index, time] of times.entries()) {
      expect(time.textContent).toBe(`Expires ${dateTimeText(expected[index]!, now)}`)
    }
    expect(times[0]!.textContent).toMatch(/^Expires Sep 13, /)
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
    open('Codex')
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

  it('marks even pace on bars that know their window and reset time', () => {
    const now = Date.UTC(2026, 8, 13, 12)
    vi.useFakeTimers({ toFake: ['Date'], now })
    render(
      limits({
        status: 'ready',
        provider: 'claude-code',
        summary: summary([
          // Half of a five-hour window is ahead: even pace leaves half.
          { label: 'Session', usedPercent: 70, windowMinutes: 300, resetsAt: now + 150 * 60_000 },
          {
            label: 'Weekly',
            usedPercent: 10,
            windowMinutes: 10_080,
            resetsAt: now + 7_000 * 60_000,
          },
          // A window that just began would put the mark on the rounded end.
          { label: 'Fresh', usedPercent: 1, windowMinutes: 300, resetsAt: now + 299 * 60_000 },
          { label: 'Unknown window', usedPercent: 40, resetsAt: now + 60_000 },
        ]),
      }),
    )
    open('Claude Code')

    const pace = (label: string) => {
      const bar = screen.getByRole('progressbar', { name: `Claude Code ${label} left` })
      const mark = bar.querySelector<HTMLElement>('.account-menu__limit-pace')
      return { title: bar.title, left: mark?.style.left }
    }
    expect(pace('Session')).toEqual({
      title: 'At an even pace, 50% would be left now.',
      left: '50%',
    })
    expect(pace('Weekly').left).toBe(`${(7_000 / 10_080) * 100}%`)
    expect(pace('Weekly').title).toBe('At an even pace, 69% would be left now.')
    expect(pace('Fresh')).toEqual({ title: '', left: undefined })
    expect(pace('Unknown window')).toEqual({ title: '', left: undefined })
  })

  it('keeps an untouched allowance to one line, with no bar and no reset time', () => {
    const now = Date.UTC(2026, 8, 13, 12)
    vi.useFakeTimers({ toFake: ['Date'], now })
    render(
      limits({
        status: 'ready',
        provider: 'antigravity',
        summary: summary([
          { label: 'Gemini 5 hours', usedPercent: 0, windowMinutes: 300 },
          {
            label: 'Gemini weekly',
            usedPercent: 0.4,
            windowMinutes: 10_080,
            resetsAt: now + 86_400_000 * 3,
          },
          {
            label: 'Claude weekly',
            usedPercent: 1,
            windowMinutes: 10_080,
            resetsAt: now + 86_400_000 * 3,
          },
        ]),
      }),
    )
    open('Antigravity')

    const row = (label: string) => screen.getByText(label).closest('.account-menu__limit')!
    for (const label of ['Gemini 5 hours', 'Gemini weekly']) {
      expect(row(label).hasAttribute('data-full')).toBe(true)
      expect(within(row(label) as HTMLElement).getByText('100% left')).toBeTruthy()
      expect(within(row(label) as HTMLElement).queryByRole('progressbar')).toBeNull()
      expect(row(label).querySelector('.account-menu__limit-reset')).toBeNull()
    }
    expect(row('Claude weekly').hasAttribute('data-full')).toBe(false)
    expect(within(row('Claude weekly') as HTMLElement).getByRole('progressbar')).toBeTruthy()
    expect(row('Claude weekly').querySelector('.account-menu__limit-reset')).not.toBeNull()
  })

  it('says when a window resets the way the Usage page does, the exact time on hover', () => {
    const now = Date.UTC(2026, 8, 13, 12)
    vi.useFakeTimers({ toFake: ['Date'], now })
    render(
      limits({
        status: 'ready',
        provider: 'codex',
        summary: summary([
          { label: '5 hours', usedPercent: 20, resetsAt: now + 41 * 60_000 },
          { label: 'Daily', usedPercent: 20, resetsAt: now + (3 * 60 + 12) * 60_000 },
          { label: 'Monthly', usedPercent: 20, resetsAt: now + 30 * 86_400_000 },
        ]),
      }),
    )
    open('Codex')

    const reset = (label: string) =>
      screen
        .getByText(label)
        .closest('.account-menu__limit')!
        .querySelector('.account-menu__limit-reset')
    expect(reset('5 hours')?.textContent).toBe('Resets in 41m')
    expect(reset('Daily')?.textContent).toBe('Resets in 3h 12m')
    expect(reset('Monthly')?.textContent).toBe('Resets Oct 13')
    expect(reset('5 hours')?.getAttribute('title')).toMatch(/^Sun, Sep 13, /)
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
    open('Codex')
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
    open('Codex')

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
    open('Codex')

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
    open('Codex')
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
    open('Codex')

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
    open('Codex')

    fireEvent.click(screen.getByRole('button', { name: 'Use rate limit reset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm use rate limit reset' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message))
    expect(screen.getByRole('button', { name: 'Use rate limit reset' })).toBeTruthy()
  })
})
