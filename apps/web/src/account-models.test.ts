import { describe, expect, it } from 'vitest'
import type { Model, ProviderAccount } from '@harness/contracts'
import {
  accountListKey,
  accountModelKey,
  hiddenListedKeys,
  modelsByAccount,
  ownModelKey,
} from './account-models.js'
import { hiddenModelKeys } from './model-catalog-visibility.js'
import {
  choicesFor,
  effectiveHiddenModels,
  modelVisibilityDefaults,
  type ModelChoice,
} from './model-catalog.js'
import { pinnableModels } from './provider-defaults.js'
import type { ProviderAccountsSnapshot } from './provider-accounts-state.js'

const PROVIDER = 'claude-code' as const

function model(id: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    displayName: id,
    description: '',
    isDefault: false,
    reasoningEfforts: [],
    serviceTiers: [],
    ...extra,
  }
}

function account(id: string, label: string): ProviderAccount {
  return { provider: PROVIDER, id, label, home: `/homes/${id}`, managed: false } as ProviderAccount
}

function snapshot(active = 'default'): ProviderAccountsSnapshot {
  return {
    phase: 'ready',
    accounts: [account('default', 'Personal'), account('work', 'Work')],
    active: { [PROVIDER]: active },
  }
}

const catalog = (models: Model[]): ModelChoice[] =>
  choicesFor({ provider: PROVIDER, sourceName: 'Claude Code', mark: 'claude' as never }, models)

const BOTH = new Set([accountListKey(PROVIDER, 'default'), accountListKey(PROVIDER, 'work')])
const LISTS = new Map([
  [accountListKey(PROVIDER, 'default'), [model('opus'), model('sonnet')]],
  [accountListKey(PROVIDER, 'work'), [model('opus'), model('haiku')]],
])

describe('modelsByAccount', () => {
  it('lists every signed-in account on its own, with its own plan', () => {
    const rows = modelsByAccount(catalog([model('opus'), model('sonnet')]), snapshot(), BOTH, LISTS)
    expect(rows.map((row) => [row.sourceName, row.key])).toEqual([
      ['Claude Code · Personal', 'claude-code:opus'],
      ['Claude Code · Personal', 'claude-code:sonnet'],
      ['Claude Code · Work', 'claude-code@work:opus'],
      ['Claude Code · Work', 'claude-code@work:haiku'],
    ])
  })

  it('files the catalog rows under the account they stand for', () => {
    const rows = modelsByAccount(
      catalog([model('opus'), model('haiku')]),
      snapshot('work'),
      BOTH,
      LISTS,
    )
    expect(rows.map((row) => row.key)).toEqual([
      'claude-code:opus',
      'claude-code:sonnet',
      'claude-code@work:opus',
      'claude-code@work:haiku',
    ])
  })

  it('leaves out an account that is not signed in, and a provider with one account', () => {
    const onlyDefault = new Set([accountListKey(PROVIDER, 'default')])
    const rows = modelsByAccount(catalog([model('opus')]), snapshot(), onlyDefault, LISTS)
    expect(rows.map((row) => row.sourceName)).toEqual(['Claude Code · Personal'])

    const single: ProviderAccountsSnapshot = {
      phase: 'ready',
      accounts: [account('default', 'Personal')],
      active: {},
    }
    const plain = catalog([model('opus')])
    expect(modelsByAccount(plain, single, new Set(), new Map())).toEqual(plain)
  })

  it('still lists accounts while the catalog has nothing for the provider', () => {
    const rows = modelsByAccount([], snapshot(), BOTH, LISTS)
    expect(rows.map((row) => row.key)).toContain('claude-code@work:haiku')
  })
})

describe('model visibility per account', () => {
  const rows = modelsByAccount(catalog([model('opus'), model('sonnet')]), snapshot(), BOTH, LISTS)
  const defaults = modelVisibilityDefaults(rows)

  it('hides a model on one account only', () => {
    const hidden = hiddenModelKeys(rows, defaults, {
      overrides: { 'claude-code@work:opus': { visible: false, at: Date.now() } },
      firstSeen: {},
    })
    expect(hidden.has('claude-code@work:opus')).toBe(true)
    expect(hidden.has('claude-code:opus')).toBe(false)
  })

  it("leaves further accounts alone when the default account's switch changes", () => {
    const hidden = hiddenModelKeys(rows, defaults, {
      overrides: { 'claude-code:opus': { visible: false, at: Date.now() } },
      firstSeen: {},
    })
    expect(hidden.has('claude-code:opus')).toBe(true)
    expect(hidden.has('claude-code@work:opus')).toBe(false)
  })

  it('keeps what was chosen while one switch stood for every account', () => {
    const before = Date.UTC(2026, 5, 1)
    const hidden = effectiveHiddenModels(
      rows,
      defaults,
      { 'claude-code:opus': { visible: false, at: before } },
      {},
    )
    expect(hidden.has('claude-code@work:opus')).toBe(true)
  })

  it("a further account's own choice wins over that older one", () => {
    const hidden = effectiveHiddenModels(
      rows,
      defaults,
      {
        'claude-code:opus': { visible: false, at: Date.UTC(2026, 5, 1) },
        'claude-code@work:opus': { visible: true, at: Date.now() },
      },
      {},
    )
    expect(hidden.has('claude-code@work:opus')).toBe(false)
    expect(hidden.has('claude-code:opus')).toBe(true)
  })

  it("does not let one account's newer model retire another account's", () => {
    const lists = new Map([
      [accountListKey(PROVIDER, 'default'), [model('Opus 4'), model('Opus 5')]],
      [accountListKey(PROVIDER, 'work'), [model('Opus 4')]],
    ])
    const split = modelsByAccount([], snapshot(), BOTH, lists)
    const start = modelVisibilityDefaults(split)
    expect(start.hidden.has(accountModelKey(PROVIDER, 'default', 'Opus 4'))).toBe(true)
    expect(start.hidden.has(accountModelKey(PROVIDER, 'work', 'Opus 4'))).toBe(false)
  })

  it('reads the catalog rows through the active account', () => {
    const accounts = snapshot('work')
    const listed = catalog([model('opus')])
    expect(ownModelKey(listed[0]!, accounts)).toBe('claude-code@work:opus')
    expect(hiddenListedKeys(listed, new Set(['claude-code:opus']), accounts).size).toBe(0)
    expect(hiddenListedKeys(listed, new Set(['claude-code@work:opus']), accounts)).toEqual(
      new Set(['claude-code:opus']),
    )
  })

  it("offers each account's own plan as its default for new chats", () => {
    expect(pinnableModels(rows, PROVIDER, new Set(), 'work').map((row) => row.model.id)).toEqual([
      'opus',
      'haiku',
    ])
    expect(pinnableModels(rows, PROVIDER, new Set(), 'default').map((row) => row.model.id)).toEqual(
      ['opus', 'sonnet'],
    )
  })
})
