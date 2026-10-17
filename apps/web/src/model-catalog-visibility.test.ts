import { describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import {
  choicesFor,
  customModelChoice,
  modelVisibilityDefaults,
  type ModelChoice,
} from './model-catalog.js'
import {
  choiceKeySource,
  chooseModelsVisibility,
  EMPTY_MODEL_VISIBILITY,
  hiddenModelKeys,
  importLegacyModelVisibility,
  legacyHiddenChoices,
  parseModelVisibility,
  recordModelSuccessors,
  serializeModelVisibility,
  settleModelVisibilitySource,
  type ModelVisibilityRecord,
} from './model-catalog-visibility.js'

function stock(
  provider: ModelChoice['provider'],
  entries: readonly (readonly [id: string, displayName: string])[],
  defaultId?: string,
): ModelChoice[] {
  const models: Model[] = entries.map(([id, displayName]) => ({
    id,
    displayName,
    isDefault: id === defaultId,
    reasoningEfforts: [],
    serviceTiers: [],
  }))
  return choicesFor({ provider, sourceName: provider, mark: 'custom' }, models)
}

// Live listings on 2026-10-16 (codex-cli 0.163, Claude Code's alias rows, Grok).
const codex = stock(
  'codex',
  [
    ['gpt-6-astra', 'GPT-6-Astra'],
    ['gpt-6.1-sol', 'GPT-6.1-Sol'],
    ['gpt-5.6-terra', 'GPT-5.6-Terra'],
    ['gpt-6-luna', 'GPT-6-Luna'],
    ['gpt-6-sol', 'GPT-6-Sol'],
    ['gpt-5.6-sol', 'GPT-5.6-Sol'],
    ['gpt-5.6-luna', 'GPT-5.6-Luna'],
    ['gpt-5.5', 'GPT-5.5'],
  ],
  'gpt-6.1-sol',
)
const claude = stock(
  'claude-code',
  [
    ['claude-fable-5-1[1m]', 'Fable 5.1'],
    ['opus', 'Opus 5.5'],
    ['sonnet', 'Sonnet 5.5'],
    ['haiku', 'Haiku 5.5'],
    ['claude-fable-5', 'Fable 5'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
  ],
  'opus',
)
const grok = stock(
  'grok',
  [
    ['grok-4.7', 'Grok 4.7'],
    ['grok-4.7-build-fast', 'Grok 4.7 Build Fast'],
    ['grok-4.6', 'Grok 4.6'],
    ['grok-4.5', 'Grok 4.5'],
  ],
  'grok-4.7',
)
const catalog = [...codex, ...claude, ...grok]
const terra6 = stock('codex', [['gpt-6-terra', 'GPT-6-Terra']])

/** Leon's saved list (format version 4), with the version each row reached. */
const leonHidden = [
  'codex:gpt-5.5',
  'codex:gpt-5.4',
  'codex:gpt-5.4-mini',
  'codex:gpt-5.3-codex-spark',
  'claude-code:claude-fable-5',
  'claude-code:claude-opus-4-8',
  'claude-code:opus%5B1m%5D',
  'claude-code:claude-opus-5',
  'claude-code:claude-sonnet-5',
  'claude-code:claude-haiku-4-5',
]
/** Rows his catalog stopped listing before the resets, so none of them reached one. */
const leonUnrecorded = new Set([
  'codex:gpt-5.4',
  'codex:gpt-5.4-mini',
  'codex:gpt-5.3-codex-spark',
  'claude-code:opus%5B1m%5D',
])
const leonRows = Object.fromEntries(
  leonHidden.filter((key) => !leonUnrecorded.has(key)).map((key) => [key, '8']),
)

/** Names without a version, so no row supersedes another. */
function plainRows(count: number): [id: string, displayName: string][] {
  const name = (index: number): string =>
    (index >= 26 ? name(Math.floor(index / 26) - 1) : '') + String.fromCharCode(97 + (index % 26))
  return Array.from({ length: count }, (_, index) => [`m-${name(index)}`, `Model ${name(index)}`])
}

function shown(
  choices: readonly ModelChoice[],
  record: ModelVisibilityRecord,
  all: readonly ModelChoice[] = choices,
) {
  const hidden = hiddenModelKeys(all, modelVisibilityDefaults(all), record)
  return choices
    .filter((choice) => !hidden.has(choice.key))
    .map((choice) => choice.model.displayName)
}

describe('model visibility record', () => {
  it("imports Leon's profile once: older generations go, what he hid stays hidden", () => {
    const choices = legacyHiddenChoices([...leonHidden, 'claude-code:sonnet'], '4', {
      ...leonRows,
      'claude-code:sonnet': '8',
    })
    // Rows that never reached their source's reset held old defaults only.
    expect(choices).not.toContain('codex:gpt-5.4')
    expect(choices).not.toContain('claude-code:opus%5B1m%5D')
    const record = importLegacyModelVisibility(choices, catalog, 1_000)

    expect(shown(codex, record, catalog)).toEqual([
      'GPT-6-Astra',
      'GPT-6.1-Sol',
      'GPT-5.6-Terra',
      'GPT-6-Luna',
    ])
    expect(shown(claude, record, catalog)).toEqual(['Fable 5.1', 'Opus 5.5', 'Haiku 5.5'])
    expect(shown(grok, record, catalog)).toEqual(['Grok 4.7'])
    // Only his own choice is stored; default-hidden rows need nothing.
    expect(record).toEqual({
      overrides: { 'claude-code:sonnet': { visible: false, at: 1_000 } },
      firstSeen: {},
    })
  })

  it('treats a list older than per-row changes, or a row that missed its reset, as defaults', () => {
    expect(legacyHiddenChoices(['codex:gpt-6-astra'], '3', {})).toEqual([])
    expect(legacyHiddenChoices(['codex:gpt-6-astra'], null, {})).toEqual([])
    // Version 4 predates Claude Code's reset (7) and Codex's (8); Grok had none.
    expect(
      legacyHiddenChoices(['claude-code:sonnet', 'codex:gpt-6-astra', 'grok:grok-4.7'], '4', {}),
    ).toEqual(['grok:grok-4.7'])
    expect(legacyHiddenChoices(['claude-code:sonnet'], '4', { 'claude-code:sonnet': '7' })).toEqual(
      ['claude-code:sonnet'],
    )
    expect(legacyHiddenChoices(['codex:gpt-6-astra'], '8', {})).toEqual(['codex:gpt-6-astra'])
  })

  it('imports a source the launch catalog lacks only once that source is listed', () => {
    const custom = customModelChoice({ provider: 'codex', modelId: 'qwen-max', displayName: 'Q' })
    const record = importLegacyModelVisibility(
      ['grok:grok-4.7', 'claude-code:sonnet', 'claude-code:claude-opus-5', custom.key],
      grok,
      1_000,
    )
    // Grok is listed and its default shows Grok 4.7: the user hid it. A custom
    // model is always known. Claude Code waits for its own listing.
    expect(record.overrides).toEqual({
      'grok:grok-4.7': { visible: false, at: 1_000 },
      [custom.key]: { visible: false, at: 1_000 },
    })
    expect(record.legacyHidden).toEqual(['claude-code:sonnet', 'claude-code:claude-opus-5'])
    // Until then those rows keep the old list's state.
    expect(shown(claude, record)).not.toContain('Sonnet 5.5')

    const settled = settleModelVisibilitySource(record, 'claude-code', claude, 2_000)
    expect(settled.legacyHidden).toBeUndefined()
    expect(settled.overrides['claude-code:sonnet']).toEqual({ visible: false, at: 2_000 })
    // Opus 5 is hidden by default now, so no choice is stored for it.
    expect(Object.hasOwn(settled.overrides, 'claude-code:claude-opus-5')).toBe(false)
    expect(shown(claude, settled)).toEqual(['Fable 5.1', 'Opus 5.5', 'Haiku 5.5'])
  })

  it('lets a newly listed generation take over from an older one the user had shown', () => {
    let record = chooseModelsVisibility(
      EMPTY_MODEL_VISIBILITY,
      ['codex:gpt-5.6-sol'],
      true,
      modelVisibilityDefaults(codex),
      1_000,
    )
    // GPT-6.1-Sol was listed when the user chose, so the choice sticks.
    expect(record.firstSeen['codex:gpt-6.1-sol']).toBe(1_000)
    expect(shown(codex, record)).toContain('GPT-5.6-Sol')

    // GPT-6-Terra appears later and takes over GPT-5.6-Terra.
    const withTerra6 = [...codex, ...terra6]
    expect(shown(withTerra6, record)).not.toContain('GPT-5.6-Terra')
    record = recordModelSuccessors(record, modelVisibilityDefaults(withTerra6), 5_000)
    expect(record.firstSeen['codex:gpt-6-terra']).toBe(5_000)
    expect(shown(withTerra6, record)).toEqual([
      'GPT-6-Astra',
      'GPT-6.1-Sol',
      'GPT-6-Luna',
      'GPT-5.6-Sol',
      'GPT-6-Terra',
    ])

    // A choice to show GPT-5.6-Terra made before GPT-6-Terra appeared gives way;
    // one made after it sticks.
    const before = chooseModelsVisibility(
      EMPTY_MODEL_VISIBILITY,
      ['codex:gpt-5.6-terra'],
      true,
      modelVisibilityDefaults(codex),
      4_000,
    )
    const later = recordModelSuccessors(before, modelVisibilityDefaults(withTerra6), 5_000)
    expect(shown(withTerra6, later)).not.toContain('GPT-5.6-Terra')
    const after = chooseModelsVisibility(
      later,
      ['codex:gpt-5.6-terra'],
      true,
      modelVisibilityDefaults(withTerra6),
      6_000,
    )
    expect(shown(withTerra6, after)).toContain('GPT-5.6-Terra')
  })

  it('keeps a choice made before its successor was noted when the successor is listed', () => {
    // The successor is in the catalog the user sees, but not noted yet.
    const record = chooseModelsVisibility(
      EMPTY_MODEL_VISIBILITY,
      ['grok:grok-4.6'],
      true,
      modelVisibilityDefaults(grok),
      3_000,
    )
    expect(record.firstSeen['grok:grok-4.7']).toBe(3_000)
    expect(recordModelSuccessors(record, modelVisibilityDefaults(grok), 9_000)).toBe(record)
    expect(shown(grok, record)).toEqual(['Grok 4.7', 'Grok 4.6'])
  })

  it('changes many rows as one update and returns the same record when nothing changes', () => {
    const rows = stock('opencode', plainRows(300))
    const defaults = modelVisibilityDefaults(rows)
    // A source this large starts with only its first four rows.
    expect(shown(rows, EMPTY_MODEL_VISIBILITY)).toHaveLength(4)
    const record = chooseModelsVisibility(
      EMPTY_MODEL_VISIBILITY,
      rows.map((choice) => choice.key),
      true,
      defaults,
      1_000,
    )
    expect(Object.keys(record.overrides)).toHaveLength(300)
    expect(shown(rows, record)).toHaveLength(300)
    expect(chooseModelsVisibility(record, [], false, defaults, 2_000)).toBe(record)
    expect(settleModelVisibilitySource(record, 'opencode', rows, 2_000)).toBe(record)
  })

  it('forgets first sightings a source no longer lists and caps choices for unlisted rows', () => {
    const rows = stock('opencode', plainRows(60))
    let record: ModelVisibilityRecord = {
      overrides: Object.fromEntries(
        rows.map((choice, index) => [choice.key, { visible: false, at: index }]),
      ),
      firstSeen: { [rows[1]!.key]: 1, 'opencode:gone': 1, 'grok:grok-4.7': 1 },
    }
    // Listing only the first row keeps the 50 most recent choices for the
    // rows it no longer lists, and every other source as it was.
    record = settleModelVisibilitySource(record, 'opencode', rows.slice(0, 1), 100)
    expect(Object.keys(record.overrides)).toHaveLength(51)
    expect(Object.hasOwn(record.overrides, rows[0]!.key)).toBe(true)
    expect(Object.hasOwn(record.overrides, rows[59]!.key)).toBe(true)
    expect(Object.hasOwn(record.overrides, rows[9]!.key)).toBe(false)
    expect(Object.hasOwn(record.overrides, rows[10]!.key)).toBe(true)
    expect(record.firstSeen).toEqual({ 'grok:grok-4.7': 1 })
  })

  it('never mistakes a custom harness of a provider for that provider', () => {
    const harness = choicesFor(
      {
        provider: 'codex',
        sourceName: 'Work',
        mark: 'openai',
        agent: { id: 'work', name: 'Work' },
      },
      [
        {
          id: 'gpt-6.1-sol',
          displayName: 'GPT-6.1-Sol',
          isDefault: true,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      ],
    )
    expect(choiceKeySource(harness[0]!.key)).toBe('codex:work')
    const record: ModelVisibilityRecord = {
      overrides: { [harness[0]!.key]: { visible: false, at: 1 } },
      firstSeen: {},
    }
    expect(settleModelVisibilitySource(record, 'codex', codex, 2)).toBe(record)
  })

  it('round-trips through storage and drops entries it cannot read', () => {
    const record: ModelVisibilityRecord = {
      overrides: { 'codex:gpt-6-astra': { visible: false, at: 5 } },
      firstSeen: { 'codex:gpt-6.1-sol': 4 },
      legacyHidden: ['cursor:auto'],
    }
    expect(parseModelVisibility(serializeModelVisibility(record))).toEqual(record)
    expect(parseModelVisibility(null)).toBeUndefined()
    expect(parseModelVisibility('{')).toBeUndefined()
    expect(parseModelVisibility('{"overrides":[]}')).toBeUndefined()
    expect(
      parseModelVisibility(
        JSON.stringify({
          overrides: { a: { visible: 'yes', at: 1 }, b: { visible: true, at: -1 } },
          firstSeen: { c: 'now' },
          legacyHidden: [1],
        }),
      ),
    ).toEqual(EMPTY_MODEL_VISIBILITY)
  })
})
