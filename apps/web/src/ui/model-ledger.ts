/**
 * The ledger picker's logic, kept free of React so it can be tested on its
 * own: which rows the list shows, where the keyboard goes, which effort a
 * highlighted model would use, and how much plan headroom an engine has.
 *
 * Everything here reads what the catalog, the usage controller and the
 * account list already report. Nothing branches on a provider's name, and
 * nothing is estimated: a number the provider did not report is not shown.
 */
import {
  DEFAULT_ACCOUNT_ID,
  type AccountId,
  type ProviderId,
  type ProviderLimit,
} from '@harness/contracts'
import {
  filterModelChoicesByQuery,
  resolveReasoningEffort,
  type ModelChoice,
  type ProviderMark,
} from '../model-catalog.js'
import type { ModelRecent } from '../model-recents.js'
import {
  PROVIDER_ORDER,
  providerDisplayName,
  providerMark,
  providerRank,
} from '../provider-presentation.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import { groupModelsBySource, modelSourceKey } from './model-selector-utils.js'

/** A source with more models than this folds the rest behind a "more" row. */
export const LEDGER_FOLD_AFTER = 8
/** How many of a folded source's models stay visible. */
export const LEDGER_FOLDED_ROWS = 5
/** Recent pairs shown at most. */
export const LEDGER_RECENTS = 3
/** Models released this recently carry a "New" tag. */
export const LEDGER_NEW_FOR_MS = 21 * 86_400_000
/** At or below this share left, a window reads as low. */
export const LEDGER_LOW_PERCENT = 15

/** The open chat, when it can move to another engine; absent in a new chat. */
export type LedgerChat = {
  /** The chat's own source key (`sourceKey` without an account). */
  source: string
  provider: ProviderId
  accountId?: AccountId | undefined
}

export type LedgerGroupStatus = 'ready' | 'updating' | 'loading' | 'failed'

export type LedgerRow =
  | { kind: 'section'; id: string; label: string }
  | {
      kind: 'group'
      id: string
      source: string
      name: string
      mark: ProviderMark
      /** Set for a provider's own source (with or without an account), never for agents. */
      provider: ProviderId | undefined
      accountId: AccountId | undefined
      status: LedgerGroupStatus
      /** Models this source lists in all, folded ones included. */
      count: number
      /** Choosing a model here moves the open chat to another engine. */
      moves: boolean
    }
  | {
      kind: 'model'
      id: string
      choice: ModelChoice
      source: string
      moves: boolean
      /** Set for a "Recent" row: the pair as it was sent. */
      recent?: { effort?: string | undefined; serviceTier?: string | undefined } | undefined
    }
  | { kind: 'more'; id: string; source: string; name: string; hidden: number }
  | { kind: 'skeleton'; id: string; width: number }
  | { kind: 'failure'; id: string; source: string; message: string }

export type LedgerModelRow = Extract<LedgerRow, { kind: 'model' }>
export type LedgerGroupRow = Extract<LedgerRow, { kind: 'group' }>

export type LedgerRowsInput = {
  models: readonly ModelChoice[]
  query: string
  recents: readonly ModelRecent[]
  /** The choice and effort the next message uses. */
  current: { key: string | undefined; effort: string | undefined }
  chat?: LedgerChat | undefined
  /** Sources still listing their models. */
  pending?: ReadonlySet<string> | undefined
  /** The last listing error of a source, by source key. */
  errors?: Readonly<Record<string, { message: string }>> | undefined
  /** Folded sources the user opened. */
  expanded?: ReadonlySet<string> | undefined
}

/** The provider a source key belongs to, when it is a provider's own source. */
export function providerOfSource(source: string): ProviderId | undefined {
  if (source.includes(':')) return undefined
  const provider = source.split('@')[0] as ProviderId
  return (PROVIDER_ORDER as readonly string[]).includes(provider) ? provider : undefined
}

function sourceRank(source: string): number {
  const provider = providerOfSource(source)
  return provider ? providerRank(provider) : PROVIDER_ORDER.length
}

type GroupDraft = {
  source: string
  name: string
  mark: ProviderMark
  provider: ProviderId | undefined
  accountId: AccountId | undefined
  entries: ModelChoice[]
  /** Every model the source lists, before the query. */
  total: number
  rank: number
}

/**
 * The rows of the list: recent pairs, then every source with its models. In
 * an open chat its own source comes first and every other engine follows
 * under "Move this chat to"; in a new chat sources keep the catalog's order.
 * A source still listing shows skeleton rows, one that failed shows why.
 */
export function buildLedgerRows(input: LedgerRowsInput): LedgerRow[] {
  const query = input.query.trim()
  const searching = query.length > 0
  const pending = input.pending ?? new Set<string>()
  const errors = input.errors ?? {}
  const expanded = input.expanded ?? new Set<string>()
  const rows: LedgerRow[] = []
  const byKey = new Map(input.models.map((choice) => [choice.key, choice]))

  if (!searching) {
    const recentRows: LedgerModelRow[] = []
    for (const recent of input.recents) {
      if (recentRows.length === LEDGER_RECENTS) break
      if (recent.key === input.current.key && recent.effort === input.current.effort) continue
      const choice = byKey.get(recent.key)
      if (!choice) continue
      const source = modelSourceKey(choice)
      recentRows.push({
        kind: 'model',
        id: `recent:${recent.key}:${recent.effort ?? ''}`,
        choice,
        source,
        moves: movesChat(source, input.chat),
        recent: { effort: recent.effort, serviceTier: recent.serviceTier },
      })
    }
    if (recentRows.length > 0) {
      rows.push({ kind: 'section', id: 'section:recent', label: 'Recent' }, ...recentRows)
    }
  }

  const totals = new Map<string, number>()
  for (const choice of input.models) {
    const source = modelSourceKey(choice)
    totals.set(source, (totals.get(source) ?? 0) + 1)
  }
  const matches = searching ? filterModelChoicesByQuery([...input.models], query) : input.models
  const drafts: GroupDraft[] = groupModelsBySource([...matches]).map((group) => {
    const first = group.entries[0]!
    const provider = first.agent || first.connectionId ? undefined : first.provider
    return {
      source: group.key,
      name: group.name,
      mark: group.mark,
      provider,
      accountId: first.accountId,
      entries: group.entries,
      total: totals.get(group.key) ?? group.entries.length,
      rank: sourceRank(group.key),
    }
  })
  if (!searching) {
    // A provider still listing, or one that failed, before it listed anything.
    const listed = new Set(drafts.map((draft) => draft.source))
    for (const source of new Set([...pending, ...Object.keys(errors)])) {
      const provider = providerOfSource(source)
      if (!provider || listed.has(source) || totals.has(source)) continue
      drafts.push({
        source,
        name: providerDisplayName(provider),
        mark: providerMark(provider),
        provider,
        accountId: undefined,
        entries: [],
        total: 0,
        rank: providerRank(provider),
      })
    }
    // Stable: sources that share a rank keep the order they arrived in.
    drafts.sort((left, right) => left.rank - right.rank)
  }

  const chatSource = input.chat?.source
  const own = chatSource ? drafts.filter((draft) => draft.source === chatSource) : drafts
  const others = chatSource ? drafts.filter((draft) => draft.source !== chatSource) : []

  const pushGroup = (draft: GroupDraft, moves: boolean) => {
    const loading = pending.has(draft.source)
    const failure = errors[draft.source]
    const status: LedgerGroupStatus = loading
      ? draft.total > 0
        ? 'updating'
        : 'loading'
      : failure
        ? 'failed'
        : 'ready'
    rows.push({
      kind: 'group',
      id: `group:${draft.source}`,
      source: draft.source,
      name: draft.name,
      mark: draft.mark,
      provider: draft.provider,
      accountId: draft.accountId,
      status,
      count: draft.total,
      moves,
    })
    if (failure && !loading) {
      rows.push({
        kind: 'failure',
        id: `failure:${draft.source}`,
        source: draft.source,
        message: failure.message,
      })
    }
    if (status === 'loading') {
      rows.push(
        { kind: 'skeleton', id: `skeleton:${draft.source}:0`, width: 118 },
        { kind: 'skeleton', id: `skeleton:${draft.source}:1`, width: 92 },
      )
      return
    }
    let visible = draft.entries
    let hidden = 0
    if (!searching && draft.entries.length > LEDGER_FOLD_AFTER && !expanded.has(draft.source)) {
      visible = draft.entries.slice(0, LEDGER_FOLDED_ROWS)
      // The model in use never hides behind the fold.
      const current = draft.entries.find(
        (choice, index) => choice.key === input.current.key && index >= LEDGER_FOLDED_ROWS,
      )
      if (current) visible = [...visible, current]
      hidden = draft.entries.length - visible.length
    }
    for (const choice of visible) {
      rows.push({ kind: 'model', id: `model:${choice.key}`, choice, source: draft.source, moves })
    }
    if (hidden > 0) {
      rows.push({
        kind: 'more',
        id: `more:${draft.source}`,
        source: draft.source,
        name: draft.name,
        hidden,
      })
    }
  }

  for (const draft of own) pushGroup(draft, false)
  if (others.length > 0) {
    rows.push({ kind: 'section', id: 'section:move', label: 'Move this chat to' })
    for (const draft of others) pushGroup(draft, true)
  }
  return rows
}

function movesChat(source: string, chat: LedgerChat | undefined): boolean {
  return chat !== undefined && source !== chat.source
}

export function isSelectableRow(row: LedgerRow | undefined): boolean {
  return row?.kind === 'model' || row?.kind === 'more'
}

/** The row a fresh open highlights: the model in use, else the first one. */
export function initialHighlight(
  rows: readonly LedgerRow[],
  currentKey: string | undefined,
): number {
  const current = rows.findIndex(
    (row) => row.kind === 'model' && !row.recent && row.choice.key === currentKey,
  )
  return current >= 0 ? current : rows.findIndex(isSelectableRow)
}

/** The next selectable row up or down; stays put at either end. */
export function stepHighlight(rows: readonly LedgerRow[], from: number, direction: 1 | -1): number {
  for (let index = from + direction; index >= 0 && index < rows.length; index += direction) {
    if (isSelectableRow(rows[index])) return index
  }
  return from
}

/**
 * The first model of the next (or previous) source, wrapping around, so Tab
 * walks provider by provider. Recent rows count as a source of their own.
 */
export function jumpToGroup(rows: readonly LedgerRow[], from: number, direction: 1 | -1): number {
  const starts: number[] = []
  let inGroup = false
  rows.forEach((row, index) => {
    if (row.kind === 'group' || row.kind === 'section') {
      inGroup = false
      return
    }
    if (isSelectableRow(row) && !inGroup) {
      starts.push(index)
      inGroup = true
    }
  })
  if (starts.length === 0) return from
  const currentGroup = starts.filter((start) => start <= from).length - 1
  const next =
    direction === 1
      ? (currentGroup + 1) % starts.length
      : currentGroup <= 0
        ? starts.length - 1
        : currentGroup - 1
  return starts[next] ?? from
}

/**
 * The effort a highlighted model would run at: a recent pair's own effort, the
 * one in use for the model in use, and for any other model the one in use
 * carried onto that model's own scale, as picking it would.
 */
export function targetEffort(
  row: LedgerModelRow,
  current: {
    key: string | undefined
    effort: string | undefined
    model: ModelChoice['model'] | undefined
  },
): string | undefined {
  const efforts = row.choice.model.reasoningEfforts
  if (efforts.length === 0) return undefined
  if (row.recent?.effort && efforts.includes(row.recent.effort)) return row.recent.effort
  if (row.choice.key === current.key && current.effort && efforts.includes(current.effort)) {
    return current.effort
  }
  return resolveReasoningEffort({
    currentEffort: current.effort,
    currentModel: current.model,
    nextModel: row.choice.model,
  })
}

/** One level up or down a model's own scale; `wrap` goes round from the top. */
export function stepEffort(
  efforts: readonly string[],
  effort: string | undefined,
  direction: 1 | -1,
  wrap = false,
): string | undefined {
  if (efforts.length === 0) return undefined
  const index = effort === undefined ? -1 : efforts.indexOf(effort)
  if (index < 0) return efforts[direction === 1 ? 0 : efforts.length - 1]
  const next = index + direction
  if (next >= efforts.length) return wrap ? efforts[0] : efforts[efforts.length - 1]
  if (next < 0) return wrap ? efforts[efforts.length - 1] : efforts[0]
  return efforts[next]
}

/** "New" for a model released in the last three weeks, by its catalog date. */
export function isNewModel(choice: ModelChoice, now: number): boolean {
  const released = choice.model.released ? Date.parse(choice.model.released) : Number.NaN
  return Number.isFinite(released) && released <= now && now - released < LEDGER_NEW_FOR_MS
}

// ---------- plan headroom ----------

/** One reported window of a plan limit, as the ledger shows it. */
export type LedgerWindow = {
  /** "5-hour", "weekly", or the provider's own label. */
  name: string
  /** "5h", "week": the short form beside a source's name. */
  short: string
  /** Percent left, rounded. */
  left: number
  resetsAt: number | undefined
  low: boolean
  /** Used up and not reset yet. */
  out: boolean
}

export type Headroom =
  | { kind: 'checking' }
  | { kind: 'windows'; windows: LedgerWindow[]; tightest: LedgerWindow }
  | { kind: 'spend'; todayUsd: number }
  | { kind: 'not-reported' }
  | { kind: 'unavailable'; message?: string | undefined }

/** How a window is named in a sentence and beside a source. */
type LedgerWindowName = Pick<LedgerWindow, 'name' | 'short'>

function windowNames(limit: ProviderLimit): LedgerWindowName {
  const minutes = limit.windowMinutes
  if (minutes === undefined) {
    const name = limit.label.trim()
    return { name: name.charAt(0).toLowerCase() + name.slice(1), short: name }
  }
  if (minutes === 10_080) return { name: 'weekly', short: 'week' }
  if (minutes === 1_440) return { name: 'daily', short: 'day' }
  if (minutes < 1_440 && minutes % 60 === 0) {
    const hours = minutes / 60
    return { name: `${hours}-hour`, short: `${hours}h` }
  }
  if (minutes < 60) return { name: `${minutes}-minute`, short: `${minutes}m` }
  const days = Math.round(minutes / 1_440)
  return { name: `${days}-day`, short: `${days}d` }
}

function windowsOf(limits: readonly ProviderLimit[], now: number): LedgerWindow[] {
  return limits
    .filter((limit) => limit.valueLabel === undefined)
    .map((limit) => {
      const left = Math.min(100, Math.max(0, Math.round(100 - limit.usedPercent)))
      const out = limit.usedPercent >= 100 && (limit.resetsAt === undefined || limit.resetsAt > now)
      return {
        ...windowNames(limit),
        left,
        resetsAt: limit.resetsAt,
        low: !out && left <= LEDGER_LOW_PERCENT,
        out,
      }
    })
}

/**
 * What a provider account has left, from what the usage controller holds for
 * it. Absent when nothing is known about that account at all.
 */
export function headroomOf(
  states: readonly UsageSummaryState[] | undefined,
  provider: ProviderId,
  accountId: AccountId | undefined,
  now: number,
): Headroom | undefined {
  const wanted = accountId ?? DEFAULT_ACCOUNT_ID
  const state = states?.find(
    (candidate) =>
      candidate.provider === provider && (candidate.accountId ?? DEFAULT_ACCOUNT_ID) === wanted,
  )
  if (!state) return undefined
  const summary = state.summary
  const source = summary?.limitSource
  const limits =
    source === undefined ? (summary?.limits ?? []) : source.status === 'ready' ? source.limits : []
  const windows = windowsOf(limits, now)
  if (windows.length > 0) {
    // A used-up window says the most; otherwise the one with the least left.
    const tightest =
      windows.find((window) => window.out) ??
      windows.reduce((least, each) => (each.left < least.left ? each : least))
    return { kind: 'windows', windows, tightest }
  }
  const spent = summary?.today.costUsd
  if (spent !== undefined && spent > 0) return { kind: 'spend', todayUsd: spent }
  if (state.status === 'loading' && !summary) return { kind: 'checking' }
  if (state.status === 'error') return { kind: 'unavailable', message: state.message }
  if (source?.status === 'unavailable' && source.reason === 'failed') {
    return { kind: 'unavailable', message: source.error }
  }
  if (state.status === 'loading' && source === undefined) return { kind: 'checking' }
  return { kind: 'not-reported' }
}

/** "16:40" today, "Thu 09:00" within the week, "12 Nov" further out. */
export function resetPhrase(at: number, now: number, locale?: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return time
  if (at > now && at - now < 6 * 86_400_000) {
    return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${time}`
  }
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

/** The short figure beside a source's name: "64% · 5h", "Used up until 16:40", "$3.20 today". */
export function headroomGlance(
  headroom: Headroom | undefined,
  now: number,
): { text: string; tone: 'quiet' | 'low' | 'out' } | undefined {
  if (!headroom) return undefined
  if (headroom.kind === 'windows') {
    const window = headroom.tightest
    if (window.out) {
      return {
        text: window.resetsAt ? `Used up until ${resetPhrase(window.resetsAt, now)}` : 'Used up',
        tone: 'out',
      }
    }
    return { text: `${window.left}% · ${window.short}`, tone: window.low ? 'low' : 'quiet' }
  }
  if (headroom.kind === 'spend') return { text: `${usd(headroom.todayUsd)} today`, tone: 'quiet' }
  return undefined
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * The same model on another account of the same provider that still has room,
 * for a source whose plan limit is used up. The one with the most left first.
 */
export function roomElsewhere(
  models: readonly ModelChoice[],
  choice: ModelChoice,
  accountOf: (choice: ModelChoice) => AccountId | undefined,
  states: readonly UsageSummaryState[] | undefined,
  now: number,
): { choice: ModelChoice; left: number | undefined } | undefined {
  if (choice.agent || choice.connectionId) return undefined
  const own = accountOf(choice) ?? DEFAULT_ACCOUNT_ID
  let best: { choice: ModelChoice; left: number | undefined } | undefined
  for (const candidate of models) {
    if (
      candidate.provider !== choice.provider ||
      candidate.agent ||
      candidate.connectionId ||
      candidate.model.id !== choice.model.id
    )
      continue
    const account = accountOf(candidate) ?? DEFAULT_ACCOUNT_ID
    if (account === own) continue
    const headroom = headroomOf(states, candidate.provider, account, now)
    if (headroom?.kind === 'windows' && headroom.tightest.out) continue
    const left = headroom?.kind === 'windows' ? headroom.tightest.left : undefined
    if (!best || (left ?? -1) > (best.left ?? -1)) best = { choice: candidate, left }
  }
  return best
}
