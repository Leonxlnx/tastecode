import { describe, expect, it } from 'vitest'
import type { ProviderAccount, ProviderId, ProviderLimit } from '@harness/contracts'
import {
  multipleText,
  planWeights,
  poolOf,
  poolSegments,
  poolsOf,
  poolUnit,
  poolWindows,
  recommendedAccounts,
  unusedShare,
} from './account-pool.js'
import type { UsageSummaryState } from './usage-summary-state.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const totals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
}

const session = (usedPercent: number, resetsAt?: number): ProviderLimit => ({
  id: 'five_hour',
  label: 'Session',
  usedPercent,
  windowMinutes: 300,
  ...(resetsAt === undefined ? {} : { resetsAt }),
})
const weekly = (usedPercent: number, resetsAt?: number): ProviderLimit => ({
  id: 'seven_day',
  label: 'Weekly',
  usedPercent,
  windowMinutes: 10_080,
  ...(resetsAt === undefined ? {} : { resetsAt }),
})

function summary(
  provider: ProviderId,
  accountId: string | undefined,
  limits: ProviderLimit[],
  extra: { stale?: true } = {},
) {
  const account = accountId === undefined ? {} : { accountId }
  return {
    session: totals,
    today: totals,
    limits,
    limitSource: { provider, ...account, status: 'ready' as const, limits, ...extra },
  }
}

/** A provider account's limits as the client holds them after a successful read. */
function ready(
  provider: ProviderId,
  accountId: string | undefined,
  limits: ProviderLimit[],
  extra: { stale?: true } = {},
): UsageSummaryState {
  return {
    status: 'ready',
    provider,
    ...(accountId === undefined ? {} : { accountId }),
    summary: summary(provider, accountId, limits, extra),
  }
}

function account(provider: ProviderId, id: string, label: string, plan?: string): ProviderAccount {
  return id === 'default'
    ? { id, provider, label, managed: false, ...(plan ? { plan } : {}) }
    : {
        id,
        provider,
        label,
        home: `C:\\accounts\\${id}`,
        managed: true,
        ...(plan ? { plan } : {}),
      }
}

/** Claude with Pro, Max and Ultra: Ultra has no 5-hour window. */
const claudeAccounts = [
  account('claude-code', 'default', 'Personal', 'Pro'),
  account('claude-code', 'max-1', 'Work', 'Max x5'),
  account('claude-code', 'ultra-1', 'Studio', 'Max x20'),
]
const claudeStates = [
  ready('claude-code', undefined, [session(40, NOW + 2 * HOUR), weekly(30, NOW + 3 * DAY)]),
  ready('claude-code', 'max-1', [session(10, NOW + 4 * HOUR), weekly(50, NOW + DAY)]),
  ready('claude-code', 'ultra-1', [weekly(20, NOW + 5 * DAY)]),
]

describe('plan weights', () => {
  it('sizes Claude plans in Pro units, per window', () => {
    expect(poolUnit('claude-code')).toBe('Pro')
    expect(planWeights('claude-code', 'Pro')).toEqual({ session: 1, weekly: 1 })
    expect(planWeights('claude-code', 'Max')).toEqual({ session: 5, weekly: 5 })
    expect(planWeights('claude-code', 'Max x5')).toEqual({ session: 5, weekly: 5 })
    // Ultra, formerly Max 20x: ten Pro a week and no 5-hour window.
    expect(planWeights('claude-code', 'Max x20')).toEqual({ weekly: 10 })
    expect(planWeights('claude-code', 'Max 20x')).toEqual({ weekly: 10 })
    expect(planWeights('claude-code', 'Ultra')).toEqual({ weekly: 10 })
    // Team seats publish a session multiple only.
    expect(planWeights('claude-code', 'Team Standard')).toEqual({ session: 1.25 })
    expect(planWeights('claude-code', 'Team Premium')).toEqual({ session: 6.25 })
  })

  it('sizes Codex plans in Plus units, per window', () => {
    expect(poolUnit('codex')).toBe('Plus')
    expect(planWeights('codex', 'Plus')).toEqual({ session: 1, weekly: 1 })
    expect(planWeights('codex', 'Team')).toEqual({ session: 1, weekly: 1 })
    expect(planWeights('codex', 'Business')).toEqual({ session: 1, weekly: 1 })
    expect(planWeights('codex', 'Pro x5')).toEqual({ session: 5, weekly: 5 })
    expect(planWeights('codex', 'Pro x20')).toEqual({ session: 20, weekly: 20 })
  })

  it('leaves plans it cannot size unknown', () => {
    for (const plan of ['Team', 'Free', 'Enterprise', 'Plus', 'Signed in']) {
      expect(planWeights('claude-code', plan), plan).toBeUndefined()
    }
    for (const plan of ['Free', 'Go', 'Enterprise', 'Edu', 'Signed in', 'API key', 'Pro']) {
      expect(planWeights('codex', plan), plan).toBeUndefined()
    }
    expect(planWeights('claude-code', undefined)).toBeUndefined()
    expect(planWeights('claude-code', '__proto__')).toBeUndefined()
    expect(planWeights('grok', 'Pro')).toBeUndefined()
    expect(poolUnit('grok')).toBeUndefined()
  })
})

describe('account pool', () => {
  it('sums each window over the accounts whose plan size for it is known', () => {
    const pool = poolOf('claude-code', claudeStates, claudeAccounts, NOW)
    expect(pool.unit).toBe('Pro')
    expect(pool.accounts.map((each) => [each.accountId, each.label, each.status])).toEqual([
      ['default', 'Personal', 'ready'],
      ['max-1', 'Work', 'ready'],
      ['ultra-1', 'Studio', 'ready'],
    ])
    const [sessionTotal, weeklyTotal] = pool.windows
    // Ultra has no session window, so the session pool is Pro and Max.
    expect(sessionTotal).toEqual({
      id: 'session',
      label: 'Session',
      kind: 'session',
      accounts: 2,
      capacity: 6,
      remaining: expect.closeTo(1 * 0.6 + 5 * 0.9, 9),
      nextResetAt: NOW + 2 * HOUR,
    })
    expect(weeklyTotal).toEqual({
      id: 'weekly',
      label: 'Weekly',
      kind: 'weekly',
      accounts: 3,
      capacity: 16,
      remaining: expect.closeTo(1 * 0.7 + 5 * 0.5 + 10 * 0.8, 9),
      nextResetAt: NOW + DAY,
    })
  })

  it('recommends the account whose weekly window resets soonest', () => {
    expect(poolOf('claude-code', claudeStates, claudeAccounts, NOW).recommended).toBe('max-1')
  })

  it('draws a segment per counted account, the soonest reset first', () => {
    const pool = poolOf('claude-code', claudeStates, claudeAccounts, NOW)
    expect(poolSegments(pool, 'weekly', NOW)).toEqual([
      { accountId: 'max-1', label: 'Work', weight: 5, left: 0.5, resetsAt: NOW + DAY },
      { accountId: 'default', label: 'Personal', weight: 1, left: 0.7, resetsAt: NOW + 3 * DAY },
      { accountId: 'ultra-1', label: 'Studio', weight: 10, left: 0.8, resetsAt: NOW + 5 * DAY },
    ])
    expect(poolSegments(pool, 'session', NOW).map((segment) => segment.accountId)).toEqual([
      'default',
      'max-1',
    ])
  })

  it('keeps an account without a known plan out of the totals, but in the pool', () => {
    const accounts = [
      account('claude-code', 'default', 'Personal', 'Pro'),
      account('claude-code', 'team-1', 'Team seat', 'Team'),
      account('claude-code', 'new-1', 'New'),
    ]
    const states = [
      ready('claude-code', undefined, [session(0, NOW + HOUR), weekly(0, NOW + 4 * DAY)]),
      ready('claude-code', 'team-1', [session(0, NOW + HOUR), weekly(0, NOW + 2 * DAY)]),
      ready('claude-code', 'new-1', [session(0, NOW + HOUR), weekly(0, NOW + 3 * DAY)]),
    ]
    const pool = poolOf('claude-code', states, accounts, NOW)
    expect(pool.accounts.map((each) => each.weights)).toEqual([
      { session: 1, weekly: 1 },
      undefined,
      undefined,
    ])
    expect(pool.windows.map((total) => [total.kind, total.accounts, total.capacity])).toEqual([
      ['session', 1, 1],
      ['weekly', 1, 1],
    ])
    // Its size is unknown, its room is not: it can still be the one to use next.
    expect(pool.recommended).toBe('team-1')
  })

  it('has no totals when no plan is known', () => {
    const accounts = [
      account('claude-code', 'default', 'Personal'),
      account('claude-code', 'work-1', 'Work'),
    ]
    const states = [
      ready('claude-code', undefined, [weekly(10, NOW + DAY)]),
      ready('claude-code', 'work-1', [weekly(10, NOW + 2 * DAY)]),
    ]
    const pool = poolOf('claude-code', states, accounts, NOW)
    expect(pool.windows).toEqual([])
    expect(pool.recommended).toBe('default')
  })

  it('reads accounts without values as unknown or unavailable, never as empty', () => {
    const states: UsageSummaryState[] = [
      { status: 'loading', provider: 'codex' },
      {
        status: 'error',
        provider: 'codex',
        accountId: 'failed-1',
        message: 'Plan limits could not be loaded.',
      },
      {
        status: 'error',
        provider: 'codex',
        accountId: 'retrying-1',
        message: 'Plan limits could not be loaded.',
        retry: { attempt: 1, of: 3, message: 'timeout' },
      },
      {
        status: 'error',
        provider: 'codex',
        accountId: 'gave-up-1',
        message: 'Plan limits could not be loaded.',
        gaveUp: true,
      },
      {
        status: 'ready',
        provider: 'codex',
        accountId: 'api-1',
        summary: {
          session: totals,
          today: totals,
          limits: [],
          limitSource: {
            provider: 'codex',
            accountId: 'api-1',
            status: 'unavailable',
            reason: 'noPlan',
          },
        },
      },
      {
        status: 'loading',
        provider: 'codex',
        accountId: 'checking-1',
        summary: {
          session: totals,
          today: totals,
          limits: [],
          limitSource: {
            provider: 'codex',
            accountId: 'checking-1',
            status: 'unavailable',
            reason: 'failed',
          },
        },
      },
      // Only a balance: nothing a window total or a recommendation can use.
      ready('codex', 'credits-1', [
        { id: 'credits', label: 'Credits', usedPercent: 0, valueLabel: 'Unlimited' },
      ]),
    ]
    const accounts = [
      account('codex', 'default', 'Personal', 'Plus'),
      ...['failed-1', 'retrying-1', 'gave-up-1', 'api-1', 'checking-1', 'credits-1'].map((id) =>
        account('codex', id, id, 'Plus'),
      ),
    ]
    const pool = poolOf('codex', states, accounts, NOW)
    expect(pool.accounts.map((each) => [each.accountId, each.status])).toEqual([
      ['default', 'unknown'],
      ['failed-1', 'unavailable'],
      ['retrying-1', 'unknown'],
      ['gave-up-1', 'unavailable'],
      ['api-1', 'unavailable'],
      ['checking-1', 'unknown'],
      ['credits-1', 'unavailable'],
    ])
    expect(pool.windows).toEqual([])
    expect(pool.recommended).toBeUndefined()
  })

  it('passes over an account at a limit, and counts nothing left of it', () => {
    const states = [
      claudeStates[0]!,
      // The soonest weekly reset, but its session is used up for another hour.
      ready('claude-code', 'max-1', [session(100, NOW + HOUR), weekly(50, NOW + DAY)]),
      claudeStates[2]!,
    ]
    const pool = poolOf('claude-code', states, claudeAccounts, NOW)
    expect(pool.accounts.map((each) => each.atLimit)).toEqual([false, true, false])
    expect(pool.recommended).toBe('default')
    expect(pool.windows[0]).toMatchObject({ kind: 'session', capacity: 6 })
    expect(pool.windows[0]!.remaining).toBeCloseTo(0.6, 9)
  })

  it('reads any used-up percent row as a limit, a model’s own weekly one included', () => {
    const states = [
      ready('claude-code', undefined, [
        session(5, NOW + HOUR),
        weekly(20, NOW + DAY),
        { id: 'seven_day_opus', label: 'Opus weekly', usedPercent: 100, windowMinutes: 10_080 },
      ]),
      ready('claude-code', 'max-1', [session(5, NOW + HOUR), weekly(20, NOW + 2 * DAY)]),
    ]
    const pool = poolOf('claude-code', states, claudeAccounts, NOW)
    // The pool's weekly window is the plan's "Weekly", not the model's.
    expect(pool.accounts[0]!.windows.map((window) => window.label)).toEqual(['Session', 'Weekly'])
    expect(pool.accounts[0]!.atLimit).toBe(true)
    expect(pool.recommended).toBe('max-1')
  })

  it('takes a window whose reset has passed as whole again', () => {
    const states = [
      ready('claude-code', undefined, [session(100, NOW - 1), weekly(100, NOW - HOUR)]),
      ready('claude-code', 'max-1', [session(50, NOW + HOUR), weekly(50, NOW + DAY)]),
    ]
    const pool = poolOf('claude-code', states, claudeAccounts, NOW)
    expect(pool.accounts[0]!.atLimit).toBe(false)
    expect(pool.windows[1]).toMatchObject({ kind: 'weekly', capacity: 6, nextResetAt: NOW + DAY })
    expect(pool.windows[1]!.remaining).toBeCloseTo(1 + 2.5, 9)
    // The passed reset says nothing about the next one, so it goes last.
    expect(pool.recommended).toBe('max-1')
    expect(
      unusedShare({ id: 'w', label: 'Weekly', kind: 'weekly', usedPercent: 80 }, NOW),
    ).toBeCloseTo(0.2, 9)
  })

  it('tells windows apart by length, with no 5-hour window on Codex Pro', () => {
    const accounts = [
      account('codex', 'default', 'Personal', 'Plus'),
      account('codex', 'pro-1', 'Pro', 'Pro x20'),
    ]
    const proWeekly: ProviderLimit = {
      id: 'codex:primary',
      label: 'Weekly',
      usedPercent: 25,
      windowMinutes: 10_080,
      resetsAt: NOW + 6 * DAY,
    }
    const states = [
      ready('codex', undefined, [
        { id: 'codex:primary', label: '5h', usedPercent: 20, windowMinutes: 300 },
        {
          id: 'codex:secondary',
          label: 'Weekly',
          usedPercent: 60,
          windowMinutes: 10_080,
          resetsAt: NOW + 2 * DAY,
        },
      ]),
      ready('codex', 'pro-1', [proWeekly]),
    ]
    expect(poolWindows([proWeekly])).toEqual([
      {
        id: 'codex:primary',
        label: 'Weekly',
        kind: 'weekly',
        usedPercent: 25,
        resetsAt: NOW + 6 * DAY,
      },
    ])
    const pool = poolOf('codex', states, accounts, NOW)
    expect(pool.unit).toBe('Plus')
    expect(pool.windows.map((total) => [total.kind, total.accounts, total.capacity])).toEqual([
      ['session', 1, 1],
      ['weekly', 2, 21],
    ])
    expect(pool.windows[1]!.remaining).toBeCloseTo(0.4 + 20 * 0.75, 9)
    expect(pool.recommended).toBe('default')
  })

  it('counts stale values as the last known ones and can still recommend them', () => {
    const states: UsageSummaryState[] = [
      ready('claude-code', undefined, [session(0, NOW + HOUR), weekly(10, NOW + 3 * DAY)]),
      ready('claude-code', 'max-1', [session(0, NOW + HOUR), weekly(10, NOW + DAY)], {
        stale: true,
      }),
      {
        // A refresh failed after a read: its values stay as the last known ones.
        status: 'error',
        provider: 'claude-code',
        accountId: 'ultra-1',
        message: 'Plan limits could not be loaded.',
        summary: summary('claude-code', 'ultra-1', [weekly(40, NOW + 2 * DAY)]),
      },
    ]
    const pool = poolOf('claude-code', states, claudeAccounts, NOW)
    expect(pool.accounts.map((each) => [each.status, each.stale])).toEqual([
      ['ready', undefined],
      ['ready', true],
      ['ready', true],
    ])
    expect(pool.windows[1]).toMatchObject({ kind: 'weekly', accounts: 3, capacity: 16 })
    expect(pool.recommended).toBe('max-1')
  })

  it('puts accounts without a weekly reset last, in their listed order', () => {
    const accounts = [
      account('codex', 'default', 'Personal', 'Plus'),
      account('codex', 'a-1', 'A', 'Plus'),
      account('codex', 'b-1', 'B', 'Plus'),
    ]
    const without = [
      ready('codex', undefined, [weekly(10)]),
      ready('codex', 'a-1', [session(10, NOW + HOUR)]),
    ]
    expect(poolOf('codex', without, accounts, NOW).recommended).toBe('default')
    const states = [...without, ready('codex', 'b-1', [weekly(90, NOW + 6 * DAY)])]
    expect(poolOf('codex', states, accounts, NOW).recommended).toBe('b-1')
  })

  it('names an account the list does not hold', () => {
    const pool = poolOf(
      'codex',
      [ready('codex', undefined, [weekly(0, NOW + DAY)]), ready('codex', 'gone-1', [])],
      [],
      NOW,
    )
    expect(pool.accounts.map((each) => [each.label, each.plan])).toEqual([
      ['Default', undefined],
      ['Account', undefined],
    ])
  })

  it('pools each provider in the order its sources are listed', () => {
    const states = [
      ready('codex', undefined, [weekly(10, NOW + DAY)]),
      ...claudeStates,
      ready('codex', 'pro-1', [weekly(10, NOW + 2 * DAY)]),
      ready('grok', undefined, [weekly(10, NOW + DAY)]),
    ]
    const accounts = [
      ...claudeAccounts,
      account('codex', 'default', 'Personal', 'Plus'),
      account('codex', 'pro-1', 'Pro', 'Pro x5'),
    ]
    const pools = poolsOf(states, accounts, NOW)
    expect(pools.map((pool) => [pool.provider, pool.accounts.length])).toEqual([
      ['codex', 2],
      ['claude-code', 3],
      ['grok', 1],
    ])
    // A provider with one account has nothing to choose between.
    expect(recommendedAccounts(pools)).toEqual({ codex: 'default', 'claude-code': 'max-1' })
  })
})

describe('multiples', () => {
  it('writes a multiple without trailing zeros', () => {
    expect(multipleText(16)).toBe('16')
    expect(multipleText(6.25)).toBe('6.25')
    expect(multipleText(9.4)).toBe('9.4')
    expect(multipleText(11.2345, 1)).toBe('11.2')
    expect(multipleText(0.04, 1)).toBe('0')
  })
})
