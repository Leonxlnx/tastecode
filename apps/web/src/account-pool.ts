import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type PoolAccount,
  type PoolWindow,
  type PoolWindowTotal,
  type ProviderAccount,
  type ProviderId,
  type ProviderLimit,
  type ProviderLimitSource,
  type ResultOf,
} from '@harness/contracts'
import { accountAtLimit } from './continue-account.js'
import type { UsageSummaryState } from './usage-summary-state.js'

/**
 * Several accounts of one provider form one pool: per window, how big the
 * pool is in units of the provider's cheapest plan and how much of it is
 * left, and which account a new chat should start on.
 *
 * Computed in the client from the limits it already holds, in the shape of
 * the server's `accounts.pool` answer, so `poolsOf` can be replaced by that
 * request. It is kept here for now because the server sums each window id
 * on its own (Claude's model weeklies become totals of their own, and a
 * Codex Plus 5-hour and a Codex Pro weekly window share `codex:primary`),
 * while this sums one Session and one Weekly window per account, told apart
 * by length.
 */

/** The 5-hour session window and the weekly window, told apart by their length. */
export type PoolWindowKind = PoolWindow['kind']

const WINDOW_MINUTES = { session: 300, weekly: 10_080 } as const satisfies Record<
  PoolWindowKind,
  number
>
const WINDOW_LABELS = { session: 'Session', weekly: 'Weekly' } as const satisfies Record<
  PoolWindowKind,
  string
>
const KINDS: readonly PoolWindowKind[] = ['session', 'weekly']

/** A plan's size per window, in units of the provider's cheapest plan. Absent: not known. */
export type PoolWeights = NonNullable<PoolAccount['weights']>

export type ProviderPool = ResultOf<'accounts.pool'> & {
  /** The cheapest plan the weights count in, such as "Pro"; absent when no plan is known. */
  unit?: string | undefined
}

type PlanTable = { unit: string; plans: ReadonlyMap<string, PoolWeights> }

/**
 * Plan sizes as of 2026-11-03 (research-plan-limits.md), the same as the
 * adapters' `claudePlanWeights` and `codexPlanWeights` on the server. Keys
 * are plan labels as the adapters report them, normalized by `planKey`. A
 * plan left out, or a window it leaves out, is unknown and stays out of the
 * totals: Claude Team's weekly multiple and Free, Enterprise or Edu plans
 * are not published. Claude Ultra (formerly Max 20x) and Codex Pro have no
 * 5-hour window, so they have a weekly size only.
 */
const PLAN_TABLES: ReadonlyMap<ProviderId, PlanTable> = new Map<ProviderId, PlanTable>([
  [
    'claude-code',
    {
      unit: 'Pro',
      plans: new Map<string, PoolWeights>([
        ['pro', { session: 1, weekly: 1 }],
        ['max', { session: 5, weekly: 5 }],
        ['max x5', { session: 5, weekly: 5 }],
        ['max x20', { weekly: 10 }],
        ['ultra', { weekly: 10 }],
        ['team', { session: 1.25 }],
        ['team standard', { session: 1.25 }],
        ['team premium', { session: 6.25 }],
      ]),
    },
  ],
  [
    'codex',
    {
      unit: 'Plus',
      plans: new Map<string, PoolWeights>([
        ['plus', { session: 1, weekly: 1 }],
        ['team', { session: 1, weekly: 1 }],
        ['business', { session: 1, weekly: 1 }],
        ['pro x5', { weekly: 5 }],
        ['pro x20', { weekly: 20 }],
      ]),
    },
  ],
])

/** "Max x20", "Max 20x" and "max ×20" are one plan. */
function planKey(plan: string): string {
  const words = plan.trim().toLowerCase().replace(/×/g, 'x').replace(/\s+/g, ' ')
  return words.replace(
    /^(.*?) ?(?:x ?(\d+)|(\d+) ?x)$/,
    (_, name: string, a?: string, b?: string) => `${name} x${a ?? b}`.trim(),
  )
}

/** A plan's size per window; undefined when the plan, or the provider's plans, are unknown. */
export function planWeights(
  provider: ProviderId,
  plan: string | undefined,
): PoolWeights | undefined {
  if (plan === undefined) return undefined
  return PLAN_TABLES.get(provider)?.plans.get(planKey(plan))
}

/** The cheapest plan a provider's pool counts in, such as "Pro" or "Plus". */
export function poolUnit(provider: ProviderId): string | undefined {
  return PLAN_TABLES.get(provider)?.unit
}

/** The limits a state holds, kept or fresh; mirrors `limitSource` in the limits view. */
function sourceOf(state: UsageSummaryState): ProviderLimitSource | undefined {
  if (state.status !== 'ready' && state.gaveUp) {
    return { provider: state.provider, status: 'unavailable' }
  }
  const summary = state.summary
  if (!summary) return undefined
  if (summary.limitSource) return summary.limitSource
  return summary.limits.length > 0
    ? { provider: state.provider, status: 'ready', limits: summary.limits }
    : { provider: state.provider, status: 'unavailable' }
}

/**
 * The first percent row of each window length, in the order reported, so
 * "Weekly" rather than a model's own weekly limit. Windows are told apart by
 * their length, never by their position: Codex Pro reports its weekly window
 * first, with no 5-hour one.
 */
export function poolWindows(limits: readonly ProviderLimit[]): PoolWindow[] {
  const windows: PoolWindow[] = []
  for (const kind of KINDS) {
    const limit = limits.find(
      (row) => row.valueLabel === undefined && row.windowMinutes === WINDOW_MINUTES[kind],
    )
    if (!limit) continue
    windows.push({
      id: limit.id ?? kind,
      label: limit.label,
      kind,
      usedPercent: limit.usedPercent,
      ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
    })
  }
  return windows
}

/**
 * As the contract has it: `ready` once limits with a Session or Weekly
 * window are held, `unknown` while none are, after a failed read or when
 * the account has no plan limits. `unavailable` (the account cannot run,
 * such as a missing folder) is only known to the server.
 */
function readingOf(state: UsageSummaryState): Pick<PoolAccount, 'status' | 'stale' | 'windows'> {
  const source = sourceOf(state)
  const windows = source?.status === 'ready' ? poolWindows(source.limits) : []
  if (source?.status !== 'ready' || windows.length === 0) return { status: 'unknown', windows: [] }
  const stale = source.stale === true || state.status === 'error'
  return { status: 'ready', ...(stale ? { stale: true as const } : {}), windows }
}

/** What is left of a window, 0 to 1. A window whose reset has passed is whole again. */
export function unusedShare(window: PoolWindow, now: number): number {
  if (window.resetsAt !== undefined && window.resetsAt <= now) return 1
  return 1 - Math.min(100, Math.max(0, window.usedPercent)) / 100
}

/** The reset still ahead; a passed one says nothing about the next. */
function nextReset(window: PoolWindow | undefined, now: number): number | undefined {
  return window?.resetsAt !== undefined && window.resetsAt > now ? window.resetsAt : undefined
}

function windowOf(account: PoolAccount, kind: PoolWindowKind): PoolWindow | undefined {
  return account.windows.find((window) => window.kind === kind)
}

/** The accounts a window's total counts: ready, with a known weight and a reading of it. */
function counted(
  accounts: readonly PoolAccount[],
  kind: PoolWindowKind,
): Array<{ account: PoolAccount; weight: number; window: PoolWindow }> {
  return accounts.flatMap((account) => {
    const weight = account.weights?.[kind]
    const window = windowOf(account, kind)
    if (account.status !== 'ready' || weight === undefined || !(weight > 0) || !window) return []
    return [{ account, weight, window }]
  })
}

function totalOf(
  accounts: readonly PoolAccount[],
  kind: PoolWindowKind,
  now: number,
): PoolWindowTotal | undefined {
  const parts = counted(accounts, kind)
  if (parts.length === 0) return undefined
  let capacity = 0
  let remaining = 0
  let nextResetAt: number | undefined
  for (const { weight, window } of parts) {
    capacity += weight
    remaining += weight * unusedShare(window, now)
    const reset = nextReset(window, now)
    if (reset !== undefined && (nextResetAt === undefined || reset < nextResetAt)) {
      nextResetAt = reset
    }
  }
  return {
    id: kind,
    label: WINDOW_LABELS[kind],
    kind,
    accounts: parts.length,
    capacity,
    remaining,
    ...(nextResetAt === undefined ? {} : { nextResetAt }),
  }
}

/** Soonest reset first; none last; equal ones in their listed order. */
function byReset<T>(entries: readonly T[], resetOf: (entry: T) => number | undefined): T[] {
  return entries
    .map((entry, index) => ({ entry, index, reset: resetOf(entry) ?? Infinity }))
    .sort((a, b) => a.reset - b.reset || a.index - b.index)
    .map(({ entry }) => entry)
}

function recommendedOf(accounts: readonly PoolAccount[], now: number): AccountId | undefined {
  const candidates = accounts.filter((account) => account.status === 'ready' && !account.atLimit)
  return byReset(candidates, (account) => nextReset(windowOf(account, 'weekly'), now))[0]?.accountId
}

function labelOf(accounts: readonly ProviderAccount[], provider: ProviderId, id: AccountId) {
  const listed = accounts.find((account) => account.provider === provider && account.id === id)
  if (listed) return listed
  return { label: id === DEFAULT_ACCOUNT_ID ? 'Default' : 'Account', plan: undefined }
}

/**
 * One provider's pool from the limit sources the client holds for its
 * accounts, in their order. Accounts without a source are not part of it:
 * the limits view reads only accounts that can run.
 */
export function poolOf(
  provider: ProviderId,
  states: readonly UsageSummaryState[],
  accounts: readonly ProviderAccount[],
  now: number,
): ProviderPool {
  const members: PoolAccount[] = []
  for (const state of states) {
    if (state.provider !== provider) continue
    const accountId = state.accountId ?? DEFAULT_ACCOUNT_ID
    if (members.some((member) => member.accountId === accountId)) continue
    const { label, plan } = labelOf(accounts, provider, accountId)
    const weights = planWeights(provider, plan)
    members.push({
      accountId,
      label,
      ...(plan === undefined ? {} : { plan }),
      ...(weights === undefined ? {} : { weights }),
      ...readingOf(state),
      atLimit: accountAtLimit([state], provider, state.accountId, now),
    })
  }
  const windows = KINDS.flatMap((kind) => totalOf(members, kind, now) ?? [])
  const unit = poolUnit(provider)
  const recommended = recommendedOf(members, now)
  return {
    provider,
    ...(unit === undefined ? {} : { unit }),
    accounts: members,
    windows,
    ...(recommended === undefined ? {} : { recommended }),
  }
}

/**
 * Every provider's pool, in the order the states list them. Called when the
 * limits or the accounts change, never per streamed delta.
 */
export function poolsOf(
  states: readonly UsageSummaryState[],
  accounts: readonly ProviderAccount[],
  now: number,
): ProviderPool[] {
  const providers: ProviderId[] = []
  for (const state of states) {
    if (!providers.includes(state.provider)) providers.push(state.provider)
  }
  return providers.map((provider) => poolOf(provider, states, accounts, now))
}

/** Per provider, the account its pool recommends for new chats. */
export type RecommendedAccounts = Partial<Record<ProviderId, AccountId>>

/** The account each provider with several accounts recommends for new chats. */
export function recommendedAccounts(pools: readonly ProviderPool[]) {
  const recommended: RecommendedAccounts = {}
  for (const pool of pools) {
    if (pool.accounts.length > 1 && pool.recommended !== undefined) {
      recommended[pool.provider] = pool.recommended
    }
  }
  return recommended
}

/** One account's part of a window's bar. */
export type PoolSegment = {
  accountId: AccountId
  label: string
  weight: number
  /** What is left of its window, 0 to 1. */
  left: number
  resetsAt?: number | undefined
}

/** A window's bar: a segment per counted account, the soonest reset first. */
export function poolSegments(
  pool: Pick<ProviderPool, 'accounts'>,
  kind: PoolWindowKind,
  now: number,
): PoolSegment[] {
  const segments = counted(pool.accounts, kind).map(({ account, weight, window }) => {
    const resetsAt = nextReset(window, now)
    return {
      accountId: account.accountId,
      label: account.label,
      weight,
      left: unusedShare(window, now),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }
  })
  return byReset(segments, (segment) => segment.resetsAt)
}

/** "16", "6.25", "9.4": a multiple of the cheapest plan, without trailing zeros. */
export function multipleText(value: number, digits = 2): string {
  const factor = 10 ** digits
  return String(Math.round(value * factor) / factor)
}
