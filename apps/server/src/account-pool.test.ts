import { describe, expect, it } from 'vitest'
import type { ProviderAccount, ProviderLimit, ProviderLimitSource } from '@harness/contracts'
import { claudePlanWeights } from '@harness/adapter-claude-code/account-home'
import { codexPlanWeights } from '@harness/adapter-codex/account-home'
import { accountPool, type PoolMember } from './account-pool.js'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

const account = (id: string, plan?: string): ProviderAccount => ({
  id,
  provider: 'codex',
  label: id === 'default' ? 'Default' : id,
  managed: id !== 'default',
  ...(plan === undefined ? {} : { plan }),
})
const ready = (limits: ProviderLimit[], stale = false): ProviderLimitSource => ({
  provider: 'codex',
  status: 'ready',
  limits,
  ...(stale ? { stale: true as const } : {}),
})
const weekly = (usedPercent: number, resetsAt?: number, id = 'codex:secondary'): ProviderLimit => ({
  id,
  label: 'Weekly',
  usedPercent,
  windowMinutes: 7 * 24 * 60,
  ...(resetsAt === undefined ? {} : { resetsAt }),
})
const session = (usedPercent: number, resetsAt?: number): ProviderLimit => ({
  id: 'codex:primary',
  label: '5-hour',
  usedPercent,
  windowMinutes: 5 * 60,
  ...(resetsAt === undefined ? {} : { resetsAt }),
})
const member = (
  id: string,
  plan: string | undefined,
  source: ProviderLimitSource | undefined,
): PoolMember => ({ account: account(id, plan), source, weights: codexPlanWeights(plan) })

describe('accountPool', () => {
  it('takes windows by their length, never their position', () => {
    // A Pro plan has no 5-hour window, so Codex reports its weekly one as primary.
    const pool = accountPool(
      'codex',
      [
        member(
          'default',
          'Pro x5',
          ready([
            { id: 'codex:primary', label: 'Weekly', usedPercent: 30, windowMinutes: 10_080 },
            { id: 'credits', label: 'Credits', usedPercent: 0, valueLabel: '$5.00' },
            { id: 'monthly', label: 'Monthly', usedPercent: 10, windowMinutes: 43_200 },
            { label: 'No id', usedPercent: 10, windowMinutes: 300 },
          ]),
        ),
      ],
      NOW,
    )
    expect(pool.accounts[0]!.windows).toEqual([
      { id: 'codex:primary', label: 'Weekly', kind: 'weekly', usedPercent: 30 },
    ])
  })

  it('reports each account with its plan, weights, state and limit', () => {
    const pool = accountPool(
      'codex',
      [
        member('default', 'Plus', ready([session(100, NOW + HOUR), weekly(40, NOW + 2 * HOUR)])),
        member('work', 'Pro x20', ready([weekly(20, NOW + 5 * HOUR)], true)),
        member('spare', undefined, undefined),
        { ...member('gone', 'Plus', undefined), unavailable: true },
      ],
      NOW,
    )
    expect(
      pool.accounts.map(({ accountId, status, atLimit }) => [accountId, status, atLimit]),
    ).toEqual([
      ['default', 'ready', true],
      ['work', 'ready', false],
      ['spare', 'unknown', false],
      ['gone', 'unavailable', false],
    ])
    expect(pool.accounts[0]).toMatchObject({ plan: 'Plus', weights: { session: 1, weekly: 1 } })
    expect(pool.accounts[1]).toMatchObject({ stale: true, weights: { weekly: 20 } })
    expect(pool.accounts[2]!.weights).toBeUndefined()
  })

  it('does not count a used-up window whose reset has passed as a limit', () => {
    const pool = accountPool(
      'codex',
      [member('default', 'Plus', ready([session(100, NOW - 1)]))],
      NOW,
    )
    expect(pool.accounts[0]!.atLimit).toBe(false)
  })

  it('sums each window id over the accounts that know their weight for its kind', () => {
    const pool = accountPool(
      'codex',
      [
        member('default', 'Plus', ready([session(50, NOW + HOUR), weekly(40, NOW + 3 * HOUR)])),
        member('work', 'Pro x20', ready([weekly(10, NOW + 2 * HOUR)])),
        // No known size: shown, but left out of the totals.
        member('spare', 'Free', ready([weekly(0, NOW + HOUR)])),
      ],
      NOW,
    )
    expect(pool.windows).toEqual([
      {
        id: 'codex:primary',
        label: '5-hour',
        kind: 'session',
        accounts: 1,
        capacity: 1,
        remaining: 0.5,
        nextResetAt: NOW + HOUR,
      },
      {
        id: 'codex:secondary',
        label: 'Weekly',
        kind: 'weekly',
        accounts: 2,
        capacity: 21,
        remaining: 18.6,
        nextResetAt: NOW + 2 * HOUR,
      },
    ])
  })

  it('uses only the weight of a window kind the plan publishes', () => {
    // Team: 1.25x Pro per session, weekly size unpublished.
    const pool = accountPool(
      'claude-code',
      [
        {
          account: { ...account('default', 'Team'), provider: 'claude-code' },
          weights: claudePlanWeights('Team'),
          source: {
            provider: 'claude-code',
            status: 'ready',
            limits: [
              { id: 'five_hour', label: 'Session', usedPercent: 20, windowMinutes: 300 },
              { id: 'seven_day', label: 'Weekly', usedPercent: 20, windowMinutes: 10_080 },
            ],
          },
        },
      ],
      NOW,
    )
    expect(pool.windows.map(({ id, capacity }) => [id, capacity])).toEqual([['five_hour', 1.25]])
  })

  it('recommends the account whose weekly allowance refills first and is not at a limit', () => {
    const pool = accountPool(
      'codex',
      [
        member('default', 'Plus', ready([weekly(30, NOW + 6 * HOUR)])),
        member('limited', 'Plus', ready([weekly(100, NOW + HOUR)])),
        member('soon', 'Plus', ready([weekly(80, NOW + 2 * HOUR)])),
        member('unread', 'Plus', undefined),
        member('no-weekly', 'Plus', ready([session(10, NOW + HOUR)])),
      ],
      NOW,
    )
    expect(pool.recommended).toBe('soon')
  })

  it('recommends an account without a weekly reset only when none has one', () => {
    const pool = accountPool(
      'codex',
      [member('default', 'Plus', ready([session(10)])), member('work', 'Plus', ready([]))],
      NOW,
    )
    expect(pool.recommended).toBe('default')
  })

  it('recommends nothing when every account is at a limit or unread', () => {
    const pool = accountPool(
      'codex',
      [
        member('default', 'Plus', ready([weekly(100, NOW + HOUR)])),
        member('work', 'Plus', undefined),
      ],
      NOW,
    )
    expect(pool.recommended).toBeUndefined()
  })
})

describe('plan weights', () => {
  it('weighs Claude plans against Pro', () => {
    expect(claudePlanWeights('Pro')).toEqual({ session: 1, weekly: 1 })
    expect(claudePlanWeights('Max x5')).toEqual({ session: 5, weekly: 5 })
    expect(claudePlanWeights('Max x20')).toEqual({ weekly: 10 })
    expect(claudePlanWeights('Team')).toEqual({ session: 1.25 })
    expect(claudePlanWeights('Enterprise')).toBeUndefined()
    expect(claudePlanWeights(undefined)).toBeUndefined()
  })

  it('weighs Codex plans against Plus', () => {
    expect(codexPlanWeights('Business')).toEqual({ session: 1, weekly: 1 })
    expect(codexPlanWeights('Pro x5')).toEqual({ weekly: 5 })
    expect(codexPlanWeights('Pro x20')).toEqual({ weekly: 20 })
    expect(codexPlanWeights('Signed in')).toBeUndefined()
  })
})
