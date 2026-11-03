import type {
  AccountId,
  PoolAccount,
  PoolWindow,
  PoolWindowTotal,
  ProviderAccount,
  ProviderLimit,
  ProviderLimitSource,
  ResultOf,
} from '@harness/contracts'
import type { PlanWeights } from './account-directory.js'

const SESSION_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60

/** What the pool knows of one account: its listing and the limits held for it. */
export type PoolMember = {
  account: ProviderAccount
  /** The limits the server holds for it; undefined when none were read yet. */
  source: ProviderLimitSource | undefined
  /** The plan's size against the provider's cheapest paid plan, per window kind, when known. */
  weights: PlanWeights | undefined
  /** It cannot run now, such as when its folder is missing. */
  unavailable?: boolean
}

/**
 * A provider's accounts as one pool, from the limits already held for each. A
 * window counts by its length, never its position: Codex reports the weekly
 * window as `primary` on plans without a 5-hour one. Rows that only hold a value
 * (credits, resets) and windows of other lengths are left out.
 */
export function accountPool(
  provider: ResultOf<'accounts.pool'>['provider'],
  members: readonly PoolMember[],
  now: number,
): ResultOf<'accounts.pool'> {
  const accounts = members.map((member) => poolAccount(member, now))
  return {
    provider,
    accounts,
    windows: poolTotals(accounts),
    ...recommendation(accounts),
  }
}

function poolAccount(member: PoolMember, now: number): PoolAccount {
  const { account, source, weights } = member
  const base = {
    accountId: account.id,
    label: account.label,
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    ...(weights === undefined ? {} : { weights }),
  }
  if (member.unavailable) return { ...base, status: 'unavailable', windows: [], atLimit: false }
  if (source?.status !== 'ready') return { ...base, status: 'unknown', windows: [], atLimit: false }
  const windows = source.limits.flatMap(poolWindow)
  return {
    ...base,
    status: 'ready',
    ...(source.stale ? { stale: true as const } : {}),
    windows,
    atLimit: windows.some(
      (window) =>
        window.usedPercent >= 100 && (window.resetsAt === undefined || window.resetsAt > now),
    ),
  }
}

function poolWindow(limit: ProviderLimit): PoolWindow[] {
  if (limit.valueLabel !== undefined || limit.id === undefined) return []
  const kind =
    limit.windowMinutes === SESSION_MINUTES
      ? 'session'
      : limit.windowMinutes === WEEK_MINUTES
        ? 'weekly'
        : undefined
  if (kind === undefined) return []
  return [
    {
      id: limit.id,
      label: limit.label,
      kind,
      usedPercent: limit.usedPercent,
      ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
    },
  ]
}

/** Each window id summed over the accounts that report it and know their weight for its kind. */
function poolTotals(accounts: readonly PoolAccount[]): PoolWindowTotal[] {
  const totals = new Map<string, PoolWindowTotal>()
  for (const account of accounts) {
    for (const window of account.windows) {
      const weight = account.weights?.[window.kind]
      if (weight === undefined) continue
      const total = totals.get(window.id) ?? {
        id: window.id,
        label: window.label,
        kind: window.kind,
        accounts: 0,
        capacity: 0,
        remaining: 0,
      }
      total.accounts += 1
      total.capacity += weight
      total.remaining += (weight * (100 - window.usedPercent)) / 100
      if (
        window.resetsAt !== undefined &&
        (total.nextResetAt === undefined || window.resetsAt < total.nextResetAt)
      )
        total.nextResetAt = window.resetsAt
      totals.set(window.id, total)
    }
  }
  return [...totals.values()].map((total) => ({
    ...total,
    capacity: round(total.capacity),
    remaining: round(total.remaining),
  }))
}

/**
 * The account a new chat would best start on: read, not at a limit, and the
 * soonest weekly reset, so the allowance that is about to refill goes first.
 * An account without a weekly reset comes after those with one.
 */
function recommendation(accounts: readonly PoolAccount[]): { recommended?: AccountId } {
  let best: { id: AccountId; reset: number } | undefined
  for (const account of accounts) {
    if (account.status !== 'ready' || account.atLimit) continue
    const resets = account.windows
      .filter((window) => window.kind === 'weekly' && window.resetsAt !== undefined)
      .map((window) => window.resetsAt!)
    const reset = resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY
    if (best === undefined || reset < best.reset) best = { id: account.accountId, reset }
  }
  return best === undefined ? {} : { recommended: best.id }
}

const round = (value: number) => Math.round(value * 100) / 100
