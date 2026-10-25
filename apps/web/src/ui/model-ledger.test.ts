import { describe, expect, it } from 'vitest'
import type { Model, ProviderLimit } from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import {
  buildLedgerRows,
  headroomGlance,
  headroomOf,
  initialHighlight,
  isNewModel,
  jumpToGroup,
  providerOfSource,
  roomElsewhere,
  stepEffort,
  stepHighlight,
  targetEffort,
  type LedgerModelRow,
  type LedgerRow,
} from './model-ledger.js'

const NOW = Date.parse('2026-10-25T10:00:00Z')

function model(id: string, displayName: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    displayName,
    isDefault: false,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    serviceTiers: [],
    ...extra,
  }
}

function choice(
  provider: ModelChoice['provider'],
  sourceName: string,
  entry: Model,
  extra: Partial<ModelChoice> = {},
): ModelChoice {
  const source = extra.accountId ? `${provider}@${extra.accountId}` : provider
  return {
    key: `${source}:${entry.id}`,
    provider,
    sourceName,
    mark: provider === 'codex' ? 'openai' : provider === 'grok' ? 'grok' : 'anthropic',
    model: entry,
    ...extra,
  }
}

const OPUS = choice(
  'claude-code',
  'Claude Code',
  model('opus-5.5', 'Opus 5.5', { isDefault: true }),
)
const SONNET = choice(
  'claude-code',
  'Claude Code',
  model('sonnet-5.5', 'Sonnet 5.5', { defaultReasoningEffort: 'medium' }),
)
const ASTRA = choice(
  'codex',
  'Codex',
  model('gpt-6-astra', 'GPT-6-Astra', {
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'medium',
    released: '2026-10-14',
  }),
)
const GROK = choice(
  'grok',
  'Grok',
  model('grok-build', 'Grok Build', { reasoningEfforts: [], defaultReasoningEffort: undefined }),
)
const MODELS = [OPUS, SONNET, ASTRA, GROK]

const kinds = (rows: readonly LedgerRow[]) =>
  rows.map((row) =>
    row.kind === 'model'
      ? `${row.recent ? 'recent' : 'model'}:${row.choice.model.id}`
      : row.kind === 'group'
        ? `group:${row.source}:${row.status}`
        : row.kind === 'section'
          ? `section:${row.label}`
          : row.kind,
  )

describe('buildLedgerRows', () => {
  it('lists recent pairs first, without the pair in use or models no longer offered', () => {
    const rows = buildLedgerRows({
      models: MODELS,
      query: '',
      recents: [
        { key: OPUS.key, effort: 'high', at: 4 },
        { key: ASTRA.key, effort: 'xhigh', at: 3 },
        { key: 'cursor:gone', effort: 'low', at: 2 },
        { key: SONNET.key, effort: 'medium', at: 1 },
      ],
      current: { key: OPUS.key, effort: 'high' },
    })
    expect(kinds(rows)).toEqual([
      'section:Recent',
      'recent:gpt-6-astra',
      'recent:sonnet-5.5',
      'group:claude-code:ready',
      'model:opus-5.5',
      'model:sonnet-5.5',
      'group:codex:ready',
      'model:gpt-6-astra',
      'group:grok:ready',
      'model:grok-build',
    ])
    const recent = rows[1] as LedgerModelRow
    expect(recent.recent?.effort).toBe('xhigh')
  })

  it('puts an open chat’s own engine first and every other one under "Move this chat to"', () => {
    const rows = buildLedgerRows({
      models: [ASTRA, OPUS, GROK],
      query: '',
      recents: [],
      current: { key: ASTRA.key, effort: 'medium' },
      chat: { source: 'codex', provider: 'codex' },
    })
    expect(kinds(rows)).toEqual([
      'group:codex:ready',
      'model:gpt-6-astra',
      'section:Move this chat to',
      'group:claude-code:ready',
      'model:opus-5.5',
      'group:grok:ready',
      'model:grok-build',
    ])
    expect(
      rows.filter((row) => row.kind === 'model').map((row) => (row as LedgerModelRow).moves),
    ).toEqual([false, true, true])
  })

  it('names an engine still listing, and one whose listing failed, in their places', () => {
    const rows = buildLedgerRows({
      models: [OPUS, GROK],
      query: '',
      recents: [],
      current: { key: OPUS.key, effort: 'high' },
      pending: new Set(['antigravity', 'claude-code']),
      errors: { opencode: { message: 'Could not load OpenCode models. opencode serve exited.' } },
    })
    expect(kinds(rows)).toEqual([
      'group:claude-code:updating',
      'model:opus-5.5',
      'group:grok:ready',
      'model:grok-build',
      'group:opencode:failed',
      'failure',
      'group:antigravity:loading',
      'skeleton',
      'skeleton',
    ])
    const group = rows.find((row) => row.kind === 'group' && row.source === 'antigravity')
    expect(group).toMatchObject({ name: 'Antigravity', mark: 'antigravity' })
  })

  it('folds a long list behind a "more" row but never hides the model in use', () => {
    const many = Array.from({ length: 38 }, (_, index) =>
      choice('opencode', 'OpenCode', model(`m-${index}`, `Model ${index}`), {
        mark: 'opencode',
      }),
    )
    const folded = buildLedgerRows({
      models: many,
      query: '',
      recents: [],
      current: { key: many[20]!.key, effort: undefined },
    })
    expect(folded.filter((row) => row.kind === 'model')).toHaveLength(6)
    expect(folded.at(-2)).toMatchObject({ kind: 'model', choice: { key: many[20]!.key } })
    expect(folded.at(-1)).toMatchObject({ kind: 'more', hidden: 32 })
    expect(folded[0]).toMatchObject({ kind: 'group', count: 38 })

    const open = buildLedgerRows({
      models: many,
      query: '',
      recents: [],
      current: { key: many[20]!.key, effort: undefined },
      expanded: new Set(['opencode']),
    })
    expect(open.filter((row) => row.kind === 'model')).toHaveLength(38)
  })

  it('searches models, providers and labs, and leaves loading engines and recents out', () => {
    const rows = buildLedgerRows({
      models: MODELS,
      query: 'son',
      recents: [{ key: ASTRA.key, effort: 'max', at: 1 }],
      current: { key: OPUS.key, effort: 'high' },
      pending: new Set(['antigravity']),
    })
    expect(kinds(rows)).toEqual(['group:claude-code:ready', 'model:sonnet-5.5'])
    expect(
      buildLedgerRows({
        models: MODELS,
        query: 'gtp 7',
        recents: [],
        current: { key: OPUS.key, effort: 'high' },
      }),
    ).toEqual([])
  })
})

describe('keyboard', () => {
  const rows = buildLedgerRows({
    models: MODELS,
    query: '',
    recents: [{ key: ASTRA.key, effort: 'xhigh', at: 1 }],
    current: { key: SONNET.key, effort: 'medium' },
  })
  const at = (id: string) => rows.findIndex((row) => row.id === id)

  it('starts on the model in use, not on its recent row', () => {
    expect(rows[initialHighlight(rows, SONNET.key)]?.id).toBe(`model:${SONNET.key}`)
  })

  it('moves model by model and stops at the ends', () => {
    const first = at(`recent:${ASTRA.key}:xhigh`)
    expect(stepHighlight(rows, first, -1)).toBe(first)
    expect(rows[stepHighlight(rows, first, 1)]?.id).toBe(`model:${OPUS.key}`)
    const last = at(`model:${GROK.key}`)
    expect(stepHighlight(rows, last, 1)).toBe(last)
  })

  it('jumps engine by engine with Tab and wraps around', () => {
    const sonnet = at(`model:${SONNET.key}`)
    expect(rows[jumpToGroup(rows, sonnet, 1)]?.id).toBe(`model:${ASTRA.key}`)
    expect(rows[jumpToGroup(rows, sonnet, -1)]?.id).toBe(`recent:${ASTRA.key}:xhigh`)
    expect(rows[jumpToGroup(rows, at(`model:${GROK.key}`), 1)]?.id).toBe(
      `recent:${ASTRA.key}:xhigh`,
    )
  })
})

describe('effort', () => {
  const current = { key: OPUS.key, effort: 'max', model: OPUS.model }
  const row = (entry: ModelChoice, recent?: { effort?: string }): LedgerModelRow => ({
    kind: 'model',
    id: entry.key,
    choice: entry,
    source: entry.provider,
    moves: false,
    recent,
  })

  it('keeps the effort in use for the model in use and a recent pair’s own effort', () => {
    expect(targetEffort(row(OPUS), current)).toBe('max')
    expect(targetEffort(row(ASTRA, { effort: 'low' }), current)).toBe('low')
  })

  it('carries the effort in use onto another model’s own scale', () => {
    // The top of one scale is the top of the next.
    expect(targetEffort(row(ASTRA), current)).toBe('ultra')
    expect(targetEffort(row(GROK), current)).toBeUndefined()
  })

  it('steps within a model’s levels, wrapping only when asked', () => {
    const levels = ['low', 'medium', 'high']
    expect(stepEffort(levels, 'medium', 1)).toBe('high')
    expect(stepEffort(levels, 'high', 1)).toBe('high')
    expect(stepEffort(levels, 'high', 1, true)).toBe('low')
    expect(stepEffort(levels, 'low', -1)).toBe('low')
    expect(stepEffort(levels, undefined, 1)).toBe('low')
    expect(stepEffort([], 'low', 1)).toBeUndefined()
  })

  it('tags models released in the last three weeks as new', () => {
    expect(isNewModel(ASTRA, NOW)).toBe(true)
    expect(isNewModel(ASTRA, NOW + 30 * 86_400_000)).toBe(false)
    expect(isNewModel(OPUS, NOW)).toBe(false)
  })
})

describe('headroom', () => {
  const limit = (extra: Partial<ProviderLimit>): ProviderLimit => ({
    label: 'Session',
    usedPercent: 36,
    windowMinutes: 300,
    resetsAt: NOW + 2 * 3_600_000,
    ...extra,
  })
  const ready = (
    provider: UsageSummaryState['provider'],
    limits: ProviderLimit[],
    accountId?: string,
    costUsd?: number,
  ): UsageSummaryState => ({
    status: 'ready',
    provider,
    ...(accountId ? { accountId } : {}),
    summary: {
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
        ...(costUsd === undefined ? {} : { costUsd }),
      },
      limits,
      limitSource: { provider, status: 'ready', limits },
    },
  })

  it('reads the tightest reported window and names it by its length', () => {
    const headroom = headroomOf(
      [
        ready('claude-code', [
          limit({}),
          limit({ label: 'Weekly', usedPercent: 59, windowMinutes: 10_080 }),
        ]),
      ],
      'claude-code',
      undefined,
      NOW,
    )
    expect(headroom).toMatchObject({ kind: 'windows', tightest: { name: 'weekly', left: 41 } })
    expect(headroomGlance(headroom, NOW)).toEqual({ text: '41% · week', tone: 'quiet' })
  })

  it('reads low at 15 % or less and says until when a used-up window is out', () => {
    const low = headroomOf([ready('grok', [limit({ usedPercent: 94 })])], 'grok', undefined, NOW)
    expect(headroomGlance(low, NOW)).toEqual({ text: '6% · 5h', tone: 'low' })
    const out = headroomOf(
      [
        ready('codex', [
          limit({ usedPercent: 100 }),
          limit({ usedPercent: 10, windowMinutes: 10_080 }),
        ]),
      ],
      'codex',
      undefined,
      NOW,
    )
    expect(out).toMatchObject({ kind: 'windows', tightest: { out: true, name: '5-hour' } })
    expect(headroomGlance(out, NOW)?.tone).toBe('out')
    expect(headroomGlance(out, NOW)?.text).toMatch(/^Used up until /)
  })

  it('says limits are not reported instead of inventing a number', () => {
    expect(headroomOf([ready('claude-code', [])], 'claude-code', undefined, NOW)).toEqual({
      kind: 'not-reported',
    })
    expect(headroomOf([ready('opencode', [], undefined, 3.2)], 'opencode', undefined, NOW)).toEqual(
      {
        kind: 'spend',
        todayUsd: 3.2,
      },
    )
    expect(headroomOf([{ status: 'loading', provider: 'grok' }], 'grok', undefined, NOW)).toEqual({
      kind: 'checking',
    })
    expect(headroomOf([], 'grok', undefined, NOW)).toBeUndefined()
  })

  it('keeps each account’s limits apart', () => {
    const states = [
      ready('codex', [limit({ usedPercent: 100 })]),
      ready('codex', [limit({ usedPercent: 8 })], 'studio'),
    ]
    expect(headroomOf(states, 'codex', 'studio', NOW)).toMatchObject({ tightest: { left: 92 } })
    expect(headroomOf(states, 'codex', 'default', NOW)).toMatchObject({ tightest: { out: true } })
  })

  it('offers the same model on another account that still has room', () => {
    const studio = choice('codex', 'Codex (studio)', ASTRA.model, { accountId: 'studio' })
    const states = [
      ready('codex', [limit({ usedPercent: 100 })]),
      ready('codex', [limit({ usedPercent: 8 })], 'studio'),
    ]
    const room = roomElsewhere(
      [ASTRA, studio, OPUS],
      ASTRA,
      (entry) => entry.accountId,
      states,
      NOW,
    )
    expect(room).toEqual({ choice: studio, left: 92 })
    expect(
      roomElsewhere(
        [ASTRA, studio],
        ASTRA,
        (entry) => entry.accountId,
        [
          ready('codex', [limit({ usedPercent: 100 })]),
          ready('codex', [limit({ usedPercent: 100 })], 'studio'),
        ],
        NOW,
      ),
    ).toBeUndefined()
  })
})

describe('providerOfSource', () => {
  it('knows a provider’s own sources and leaves agents and connections out', () => {
    expect(providerOfSource('codex')).toBe('codex')
    expect(providerOfSource('claude-code@studio')).toBe('claude-code')
    expect(providerOfSource('acp:gemini')).toBeUndefined()
    expect(providerOfSource('api:openrouter')).toBeUndefined()
    expect(providerOfSource('custom:codex')).toBeUndefined()
  })
})
