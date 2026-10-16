import { describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import {
  agentMark,
  choicesFor,
  customModelChoice,
  customModelKey,
  effectiveHiddenModels,
  filterModelChoicesByQuery,
  importLegacyVisibility,
  isCustomModelChoice,
  modelVisibilityDefaults,
  providerDisplayName,
  readModelLineage,
  resolveReasoningEffort,
  type ModelChoice,
} from './model-catalog.js'

const model: Model = {
  id: 'shared-model',
  displayName: 'Shared model',
  isDefault: true,
  reasoningEfforts: [],
  serviceTiers: [],
}

function reasoningModel(reasoningEfforts: string[], defaultReasoningEffort?: string): Model {
  return {
    ...model,
    reasoningEfforts,
    ...(defaultReasoningEffort
      ? {
          defaultReasoningEffort,
        }
      : {}),
  }
}

describe('model catalog', () => {
  it('gives custom models their own source bucket and choice shape', () => {
    const choice = customModelChoice(
      { provider: 'codex', modelId: 'qwen-max', displayName: 'Qwen Max' },
      'Codex',
      'openai',
    )
    expect(choice.key).toBe(
      customModelKey({ provider: 'codex', modelId: 'qwen-max', displayName: 'Qwen Max' }),
    )
    expect(choice.key.startsWith('custom:codex:')).toBe(true)
    expect(choice.provider).toBe('codex')
    expect(choice.sourceName).toBe('Codex')
    expect(choice.mark).toBe('openai')
    expect(choice.model).toMatchObject({
      id: 'qwen-max',
      displayName: 'Qwen Max',
      reasoningEfforts: [],
      serviceTiers: [],
    })
    expect(isCustomModelChoice(choice)).toBe(true)
    expect(
      isCustomModelChoice(
        choicesFor({ provider: 'codex', sourceName: 'Codex', mark: 'openai' }, [model])[0]!,
      ),
    ).toBe(false)
  })

  it('falls back to the model id for the display name and keeps provider buckets distinct', () => {
    const codex = customModelChoice(
      { provider: 'codex', modelId: 'qwen-max', displayName: '' },
      'Codex',
      'openai',
    )
    const opencode = customModelChoice(
      { provider: 'opencode', modelId: 'qwen-max', displayName: 'Qwen Max' },
      'OpenCode',
      'opencode',
    )
    expect(codex.model.displayName).toBe('qwen-max')
    expect(codex.key).not.toBe(opencode.key)
    expect(providerDisplayName('codex')).toBe('Codex')
    expect(providerDisplayName('claude-code')).toBe('Claude Code')
  })

  it('keeps matching model ids separate across connections', () => {
    const first = choicesFor(
      { provider: 'api', connectionId: 'work', sourceName: 'Work', mark: 'openai' },
      [model],
    )[0]
    const second = choicesFor(
      { provider: 'api', connectionId: 'personal', sourceName: 'Personal', mark: 'openai' },
      [model],
    )[0]

    expect(first?.key).not.toBe(second?.key)
  })

  it('canonicalizes direct model sources while preserving named API sources', () => {
    const direct = choicesFor({ provider: 'claude-code', sourceName: 'Claude', mark: 'custom' }, [
      model,
    ])[0]
    const api = choicesFor(
      {
        provider: 'api',
        connectionId: 'work',
        sourceName: 'Work OpenRouter',
        mark: 'openrouter',
      },
      [model],
    )[0]

    expect(direct).toMatchObject({ sourceName: 'Claude Code', mark: 'anthropic' })
    expect(api).toMatchObject({ sourceName: 'Work OpenRouter', mark: 'openrouter' })
  })

  it('keeps a custom executable distinct from its stock provider source', () => {
    const custom = choicesFor(
      {
        provider: 'codex',
        sourceName: 'Work Codex fork',
        mark: 'openai',
        agent: { id: 'work-codex', name: 'Work Codex fork' },
      },
      [model],
    )[0]
    const stock = choicesFor({ provider: 'codex', sourceName: 'Codex', mark: 'openai' }, [model])[0]

    expect(custom).toMatchObject({ sourceName: 'Work Codex fork' })
    expect(custom?.key).toBe('codex:work-codex:shared-model')
    expect(custom?.key).not.toBe(stock?.key)
  })

  it.each([
    ['gemini', 'gemini'],
    ['kimi', 'kimi'],
    ['qwen', 'qwen'],
    ['another-agent', 'acp'],
  ] as const)('uses the correct mark for %s', (agent, mark) => {
    expect(agentMark(agent)).toBe(mark)
  })

  it('can omit a fake fallback when discovery is authoritative', () => {
    expect(
      choicesFor(
        {
          provider: 'acp',
          sourceName: 'Kimi CLI',
          mark: 'kimi',
          agent: { id: 'kimi', name: 'Kimi CLI' },
        },
        [],
        false,
      ),
    ).toEqual([])
  })

  it('filters model choices by case-insensitive words from their visible name or id', () => {
    const choices = choicesFor({ provider: 'opencode', sourceName: 'OpenCode', mark: 'opencode' }, [
      { ...model, id: 'openrouter/claude-opus-5', displayName: 'OpenRouter · Claude Opus 5' },
      { ...model, id: 'qwen/qwen3.8-max', displayName: 'OpenCode Go · Qwen3.8 Max' },
    ])

    expect(filterModelChoicesByQuery(choices, 'OPUS openrouter')).toEqual([choices[0]])
    expect(filterModelChoicesByQuery(choices, 'qwen3.8-max')).toEqual([choices[1]])
    expect(filterModelChoicesByQuery(choices, '  ')).toBe(choices)
  })

  describe('default visibility', () => {
    const named = (entries: [id: string, displayName: string][]) =>
      entries.map(([id, displayName]) => ({ ...model, id, displayName }))
    const codex = (entries: [id: string, displayName: string][]) =>
      choicesFor({ provider: 'codex', sourceName: 'Codex', mark: 'openai' }, named(entries))
    const claude = (entries: [id: string, displayName: string][]) =>
      choicesFor(
        { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
        named(entries),
      )
    const shown = (choices: readonly ModelChoice[], hidden: ReadonlySet<string>) =>
      choices.filter((choice) => !hidden.has(choice.key)).map((choice) => choice.model.displayName)
    // What codex-cli 0.154 and 0.163 list, in the adapter's order.
    const codex154 = codex([
      ['gpt-6-astra', 'GPT-6-Astra'],
      ['gpt-5.6-sol', 'GPT-5.6-Sol'],
      ['gpt-5.6-terra', 'GPT-5.6-Terra'],
      ['gpt-5.6-luna', 'GPT-5.6-Luna'],
      ['gpt-5.5', 'GPT-5.5'],
    ])
    const codex163 = codex([
      ['gpt-6-astra', 'GPT-6-Astra'],
      ['gpt-6.1-sol', 'GPT-6.1-Sol'],
      ['gpt-5.6-terra', 'GPT-5.6-Terra'],
      ['gpt-6-luna', 'GPT-6-Luna'],
      ['gpt-6-sol', 'GPT-6-Sol'],
      ['gpt-5.6-sol', 'GPT-5.6-Sol'],
      ['gpt-5.6-luna', 'GPT-5.6-Luna'],
      ['gpt-5.5', 'GPT-5.5'],
    ])

    it('shows the newest generation of each Codex tier and hides the rest', () => {
      expect(shown(codex163, modelVisibilityDefaults(codex163).hidden)).toEqual([
        'GPT-6-Astra',
        'GPT-6.1-Sol',
        'GPT-5.6-Terra',
        'GPT-6-Luna',
      ])
      expect(shown(codex154, modelVisibilityDefaults(codex154).hidden)).toEqual([
        'GPT-6-Astra',
        'GPT-5.6-Sol',
        'GPT-5.6-Terra',
        'GPT-5.6-Luna',
      ])
    })

    it("shows Claude Code's current lineup under its aliases and hides older generations", () => {
      const catalog = claude([
        ['claude-fable-5-1[1m]', 'Fable 5.1'],
        ['opus', 'Opus 5.5'],
        ['sonnet', 'Sonnet 5.5'],
        ['haiku', 'Haiku 5.5'],
        ['claude-fable-5', 'Fable 5'],
        ['claude-opus-5', 'Opus 5'],
        ['claude-opus-4-8', 'Opus 4.8'],
        ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
        ['claude-mythos-1', 'Mythos 1'],
      ])
      expect(shown(catalog, modelVisibilityDefaults(catalog).hidden)).toEqual([
        'Fable 5.1',
        'Opus 5.5',
        'Sonnet 5.5',
        'Haiku 5.5',
        'Mythos 1',
      ])
    })

    it('compares generations within one source and keeps known legacy models hidden', () => {
      const work = choicesFor(
        {
          provider: 'claude-code',
          sourceName: 'Work Claude',
          mark: 'anthropic',
          agent: { id: 'work-claude', name: 'Work Claude' },
        },
        named([['claude-opus-4-8', 'Opus 4.8']]),
      )
      const grok = choicesFor(
        { provider: 'grok', sourceName: 'Grok', mark: 'grok' },
        named([
          ['grok-4.7', 'Grok 4.7'],
          ['grok-4.7-build-fast', 'Grok 4.7 Build Fast'],
        ]),
      )
      const catalog = [...claude([['opus', 'Opus 5.5']]), ...work, ...grok]
      expect(shown(catalog, modelVisibilityDefaults(catalog).hidden)).toEqual([
        'Opus 5.5',
        'Opus 4.8',
        'Grok 4.7',
      ])
    })

    it('never hides a model whose name does not read as one family and version', () => {
      const catalog = choicesFor(
        { provider: 'grok', sourceName: 'Grok', mark: 'grok' },
        named([
          ['a', 'Llama 3.3 70B'],
          ['b', 'Llama 3.1 8B'],
          ['c', 'GPT-4o'],
          ['d', 'GPT-4o mini'],
          ['e', 'claude-opus-4-1-20250805'],
          ['f', 'claude-opus-4-20250514'],
          ['g', 'Provider model'],
        ]),
      )
      expect(modelVisibilityDefaults(catalog).hidden.size).toBe(0)
    })

    it('never hides a custom model', () => {
      const custom = customModelChoice({
        provider: 'codex',
        modelId: 'gpt-5.6-sol-preview',
        displayName: 'GPT-5.6-Sol',
      })
      expect(modelVisibilityDefaults([...codex163, custom]).hidden.has(custom.key)).toBe(false)
    })
  })

  describe('generic default visibility', () => {
    const named = (entries: readonly (readonly [id: string, displayName: string])[]) =>
      entries.map(([id, displayName]) => ({ ...model, id, displayName, isDefault: false }))
    const stock = (
      provider: ModelChoice['provider'],
      entries: readonly (readonly [id: string, displayName: string])[],
      defaultId?: string,
    ) =>
      choicesFor(
        { provider, sourceName: provider, mark: 'custom' },
        named(entries).map((entry) => ({ ...entry, isDefault: entry.id === defaultId })),
      )
    const shown = (choices: readonly ModelChoice[], hidden: ReadonlySet<string>) =>
      choices.filter((choice) => !hidden.has(choice.key)).map((choice) => choice.model.displayName)
    const defaultsShown = (choices: readonly ModelChoice[]) =>
      shown(choices, modelVisibilityDefaults(choices).hidden)

    // Live listings on 2026-10-16: codex-cli 0.163 in the adapter's order,
    // Claude Code's rows under their aliases as Leon's profile cached them,
    // and Grok's CLI list.
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
        ['claude-opus-4-7', 'Opus 4.7'],
        ['claude-opus-4-6', 'Opus 4.6'],
        ['claude-sonnet-4-6', 'Sonnet 4.6'],
        ['claude-opus-4-5', 'Opus 4.5'],
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
    // Leon's saved hidden list (format version 4), keys only.
    const leonHidden = [
      'codex:gpt-5.5',
      'codex:gpt-5.4',
      'codex:gpt-5.4-mini',
      'codex:gpt-5.3-codex-spark',
      'claude-code:claude-fable-5',
      'claude-code:claude-opus-4-8',
      'claude-code:claude-opus-4-7',
      'claude-code:claude-opus-4-6',
      'claude-code:claude-opus-4-5',
      'claude-code:claude-sonnet-4-6',
      'claude-code:opus%5B1m%5D',
      'claude-code:claude-opus-5',
      'claude-code:claude-sonnet-5',
      'claude-code:claude-haiku-4-5-20251001',
      'claude-code:claude-haiku-4-5',
    ]
    const leonVisible = {
      codex: ['GPT-6-Astra', 'GPT-6.1-Sol', 'GPT-5.6-Terra', 'GPT-6-Luna'],
      claude: ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'],
      grok: ['Grok 4.7'],
    }

    it("shows each live source's newest generations and hides the rest", () => {
      expect(defaultsShown(codex)).toEqual(leonVisible.codex)
      expect(defaultsShown(claude)).toEqual(leonVisible.claude)
      expect(defaultsShown(grok)).toEqual(leonVisible.grok)
      const { supersededBy } = modelVisibilityDefaults(catalog)
      expect(supersededBy.get('codex:gpt-5.6-sol')).toBe('codex:gpt-6.1-sol')
      expect(supersededBy.get('codex:gpt-6-sol')).toBe('codex:gpt-6.1-sol')
      expect(supersededBy.get('grok:grok-4.5')).toBe('grok:grok-4.7')
      // A legacy model with no newer generation is hidden but not superseded.
      expect(supersededBy.has('grok:grok-4.7-build-fast')).toBe(false)
    })

    it("resets Leon's saved profile to the current lineup once and keeps what he hid", () => {
      const defaults = modelVisibilityDefaults(catalog)
      // He also hid Sonnet 5.5 himself, which no default hides.
      const overrides = importLegacyVisibility(
        [...leonHidden, 'claude-code:sonnet'],
        catalog,
        defaults,
        1_000,
      )
      const hidden = effectiveHiddenModels(catalog, defaults, overrides, {})

      expect(shown(codex, hidden)).toEqual(leonVisible.codex)
      expect(shown(claude, hidden)).toEqual(leonVisible.claude.filter((n) => n !== 'Sonnet 5.5'))
      expect(shown(grok, hidden)).toEqual(leonVisible.grok)
      // Keys this catalog does not list keep their saved state; default-hidden
      // keys need no override.
      expect(Object.keys(overrides).sort()).toEqual([
        'claude-code:claude-haiku-4-5-20251001',
        'claude-code:opus%5B1m%5D',
        'claude-code:sonnet',
        'codex:gpt-5.3-codex-spark',
        'codex:gpt-5.4',
        'codex:gpt-5.4-mini',
      ])
      expect(overrides['claude-code:sonnet']).toEqual({ visible: false, at: 1_000 })
    })

    it('hands an older generation over once a newer one is listed', () => {
      const withTerra6 = [...codex, ...stock('codex', [['gpt-6-terra', 'GPT-6-Terra']])]
      const defaults = modelVisibilityDefaults(withTerra6)

      expect(defaults.hidden.has('codex:gpt-5.6-terra')).toBe(true)
      expect(defaults.supersededBy.get('codex:gpt-5.6-terra')).toBe('codex:gpt-6-terra')
      expect(shown(withTerra6, defaults.hidden)).toEqual([
        'GPT-6-Astra',
        'GPT-6.1-Sol',
        'GPT-6-Luna',
        'GPT-6-Terra',
      ])
    })

    it('keeps an older generation shown after its successor appeared, not before', () => {
      const withTerra6 = [...codex, ...stock('codex', [['gpt-6-terra', 'GPT-6-Terra']])]
      const defaults = modelVisibilityDefaults(withTerra6)
      const firstSeen = { 'codex:gpt-6-terra': 5_000 }
      const hiddenWith = (at: number) =>
        effectiveHiddenModels(
          withTerra6,
          defaults,
          { 'codex:gpt-5.6-terra': { visible: true, at } },
          firstSeen,
        ).has('codex:gpt-5.6-terra')

      expect(hiddenWith(4_999)).toBe(true)
      expect(hiddenWith(5_000)).toBe(false)
      expect(hiddenWith(6_000)).toBe(false)
      // A successor without a recorded sighting was only just listed.
      expect(
        effectiveHiddenModels(
          withTerra6,
          defaults,
          { 'codex:gpt-5.6-terra': { visible: true, at: 6_000 } },
          {},
        ).has('codex:gpt-5.6-terra'),
      ).toBe(true)
      // A model the user hid stays hidden, a newest one shown stays shown.
      const overridden = effectiveHiddenModels(
        withTerra6,
        defaults,
        {
          'codex:gpt-6-astra': { visible: false, at: 1 },
          'codex:gpt-6-sol': { visible: true, at: 9_000 },
        },
        { 'codex:gpt-6.1-sol': 1_000 },
      )
      expect(overridden.has('codex:gpt-6-astra')).toBe(true)
      expect(overridden.has('codex:gpt-6-sol')).toBe(false)
    })

    it('reads versions with letter prefixes and context sizes out of names', () => {
      const cursor = stock('cursor', [
        ['claude-opus-5-5-1m', 'Claude Opus 5.5 1M'],
        ['claude-opus-4-8-1m', 'Claude Opus 4.8 1M'],
        ['claude-fable-5-1-1m-no-zdr', 'Claude Fable 5.1 1M (NO ZDR)'],
        ['muse-wonder-300k', 'Muse Wonder 300K'],
      ])
      const cursorDefaults = modelVisibilityDefaults(cursor)
      expect(cursorDefaults.supersededBy.get('cursor:claude-opus-4-8-1m')).toBe(
        'cursor:claude-opus-5-5-1m',
      )
      expect(shown(cursor, cursorDefaults.hidden)).toEqual([
        'Claude Opus 5.5 1M',
        'Claude Fable 5.1 1M (NO ZDR)',
        'Muse Wonder 300K',
      ])

      const opencode = stock('opencode', [
        ['minimax/MiniMax-M3', 'MiniMax-M3'],
        ['minimax/MiniMax-M2.7', 'MiniMax-M2.7'],
        ['minimax/MiniMax-M3.1-Flash-Preview', 'MiniMax-M3.1-Flash-Preview'],
        ['deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
        ['deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash'],
      ])
      expect(defaultsShown(opencode)).toEqual([
        'MiniMax-M3',
        'MiniMax-M3.1-Flash-Preview',
        'DeepSeek V4.1 Flash',
      ])

      expect(readModelLineage('MiniMax-M2.7')).toEqual({ family: 'minimax m#', generation: [2, 7] })
      expect(readModelLineage('Qwen3.6 Coder')).toEqual({
        family: 'qwen# coder',
        generation: [3, 6],
      })
      expect(readModelLineage('GPT-5.10')?.generation).toEqual([5, 10])
      for (const name of ['GPT-4o', 'Reka Edge 2603', 'Gemini 2.5 Pro 05-06', 'Muse 300K', '4.7']) {
        expect(readModelLineage(name)).toBeUndefined()
      }
    })

    it('compares generations only within one source', () => {
      const harness = choicesFor(
        {
          provider: 'claude-code',
          sourceName: 'Work Claude',
          mark: 'anthropic',
          agent: { id: 'work-claude', name: 'Work Claude' },
        },
        named([['claude-opus-4-8', 'Opus 4.8']]),
      )
      const connection = (connectionId: string, entries: [string, string][]) =>
        choicesFor(
          { provider: 'api', connectionId, sourceName: connectionId, mark: 'openrouter' },
          named(entries),
        )
      const choices = [
        ...stock('claude-code', [['opus', 'Opus 5.5']]),
        ...harness,
        ...connection('work', [['openai/gpt-6', 'GPT-6']]),
        ...connection('personal', [['openai/gpt-5', 'GPT-5']]),
      ]
      expect(defaultsShown(choices)).toEqual(['Opus 5.5', 'Opus 4.8', 'GPT-6', 'GPT-5'])
    })

    it('shows only the first rows and the default of a source with more than 20 rows left', () => {
      const rows = (count: number) =>
        Array.from(
          { length: count },
          (_, index) => [`model-${index}`, `Model ${String.fromCharCode(97 + index)}`] as const,
        )
      const names = (entries: readonly (readonly [string, string])[]) =>
        entries.map(([, displayName]) => displayName)
      const large = stock('opencode', rows(21), 'model-10')
      expect(defaultsShown(large)).toEqual(['Model a', 'Model b', 'Model c', 'Model d', 'Model k'])
      expect(defaultsShown(stock('opencode', rows(20)))).toHaveLength(20)
      // Superseded rows do not count toward the 20: 24 rows, 4 of them older.
      const withOlder = stock('opencode', [
        ...rows(19),
        ...[1, 2, 3, 4, 5].map((version) => [`older-${version}`, `Older ${version}`] as const),
      ])
      expect(defaultsShown(withOlder)).toEqual([...names(rows(19)), 'Older 5'])
    })

    describe('what the adapter declares', () => {
      const declared = (
        provider: ModelChoice['provider'],
        rows: readonly (Partial<Model> & { id: string })[],
      ) =>
        choicesFor(
          { provider, sourceName: provider, mark: 'custom' },
          rows.map((row) => ({ ...model, isDefault: false, displayName: row.id, ...row })),
        )

      it('uses a declared family and generation instead of reading the name', () => {
        // Cursor-style names the parser cannot read as one family and version.
        const cursor = declared('cursor', [
          { id: 'claude-4.6-opus-thinking', family: 'claude-opus-thinking', generation: '4.6' },
          { id: 'claude-opus-5-5-thinking', family: 'claude-opus-thinking', generation: '5.5' },
          { id: 'claude-opus-5-5', family: 'claude-opus', generation: '5.5' },
          { id: 'claude-opus-4-8', family: 'claude-opus', generation: '4.8' },
        ])
        const defaults = modelVisibilityDefaults(cursor)
        expect(shown(cursor, defaults.hidden)).toEqual([
          'claude-opus-5-5-thinking',
          'claude-opus-5-5',
        ])
        expect(defaults.supersededBy.get('cursor:claude-4.6-opus-thinking')).toBe(
          'cursor:claude-opus-5-5-thinking',
        )

        // Two names that read as one family stay apart when the adapter says so.
        const split = declared('opencode', [
          { id: 'a', displayName: 'MiniMax-M3', family: 'minimax-m', generation: '3' },
          { id: 'b', displayName: 'MiniMax-M2.7', family: 'minimax-m-coding', generation: '2.7' },
        ])
        expect(defaultsShown(split)).toEqual(['MiniMax-M3', 'MiniMax-M2.7'])
      })

      it('reads the name when the adapter declares only one half of a lineage', () => {
        const half = declared('opencode', [
          { id: 'a', displayName: 'DeepSeek V4.1 Flash', family: 'deepseek-flash' },
          { id: 'b', displayName: 'DeepSeek V4 Flash', generation: '4' },
        ])
        expect(defaultsShown(half)).toEqual(['DeepSeek V4.1 Flash'])
      })

      it('starts a deprecated model hidden without letting it replace an older one', () => {
        const rows = declared('opencode', [
          { id: 'gpt-7-sol', displayName: 'GPT-7-Sol', deprecated: true },
          { id: 'gpt-6-sol', displayName: 'GPT-6-Sol' },
          { id: 'gpt-5-sol', displayName: 'GPT-5-Sol' },
        ])
        const defaults = modelVisibilityDefaults(rows)
        expect(shown(rows, defaults.hidden)).toEqual(['GPT-6-Sol'])
        expect(defaults.supersededBy.get('opencode:gpt-6-sol')).toBeUndefined()
        expect(defaults.supersededBy.get('opencode:gpt-5-sol')).toBe('opencode:gpt-6-sol')
        // Showing it is still the user's call.
        expect(
          effectiveHiddenModels(
            rows,
            defaults,
            { 'opencode:gpt-7-sol': { visible: true, at: 1 } },
            {},
          ).has('opencode:gpt-7-sol'),
        ).toBe(false)
      })

      it("shows only a source's recommended rows and its default, whatever its size", () => {
        const rows = (count: number) =>
          Array.from({ length: count }, (_, index) => ({
            id: `model-${index}`,
            displayName: `Model ${String.fromCharCode(97 + index)}`,
          }))
        const small = declared('opencode', [
          ...rows(3),
          { id: 'pick', displayName: 'Pick', recommended: true },
          { id: 'agent-default', displayName: 'Agent default', isDefault: true },
        ])
        expect(defaultsShown(small)).toEqual(['Pick', 'Agent default'])

        // The recommended set replaces the first-four rule of a large source.
        const large = declared('opencode', [
          ...rows(30),
          { id: 'flash', displayName: 'Flash', recommended: true },
          { id: 'pro', displayName: 'Pro', recommended: true },
        ])
        expect(defaultsShown(large)).toEqual(['Flash', 'Pro'])

        // Another source without recommendations keeps the generic rules.
        const other = declared('cursor', rows(3))
        expect(defaultsShown([...small, ...other])).toEqual([
          'Pick',
          'Agent default',
          'Model a',
          'Model b',
          'Model c',
        ])
      })
    })

    it('never hides a custom model by default, but honours hiding it', () => {
      const custom = customModelChoice({
        provider: 'codex',
        modelId: 'gpt-5.6-sol-preview',
        displayName: 'GPT-5.6-Sol',
      })
      const choices = [...codex, custom]
      const defaults = modelVisibilityDefaults(choices)
      expect(defaults.hidden.has(custom.key)).toBe(false)
      expect(
        effectiveHiddenModels(
          choices,
          defaults,
          { [custom.key]: { visible: false, at: 1 } },
          {},
        ).has(custom.key),
      ).toBe(true)
    })
  })

  it('keeps an effort that the next model supports', () => {
    expect(
      resolveReasoningEffort({
        currentEffort: 'medium',
        currentModel: reasoningModel(['low', 'medium', 'high']),
        nextModel: reasoningModel(['low', 'medium', 'high', 'max'], 'low'),
      }),
    ).toBe('medium')
  })

  it('keeps highest effort at the highest stop when the next model adds higher labels', () => {
    expect(
      resolveReasoningEffort({
        currentEffort: 'high',
        currentModel: reasoningModel(['low', 'medium', 'high']),
        nextModel: reasoningModel(['low', 'medium', 'high', 'max', 'ultra'], 'low'),
      }),
    ).toBe('ultra')
  })

  it.each(['max', 'ultra'])("maps %s to the next model's highest supported effort", (effort) => {
    expect(
      resolveReasoningEffort({
        currentEffort: effort,
        currentModel: reasoningModel(['low', 'medium', 'high', 'max', 'ultra']),
        nextModel: reasoningModel(['low', 'medium', 'high'], 'low'),
      }),
    ).toBe('high')
  })

  it("carries Codex's Ultra and Claude Code's Ultracode onto each other's top level", () => {
    const codex = reasoningModel(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    const claude = reasoningModel(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    const resolve = (currentEffort: string, currentModel: typeof codex, nextModel: typeof codex) =>
      resolveReasoningEffort({ currentEffort, currentModel, nextModel })

    expect(resolve('ultra', codex, claude)).toBe('ultracode')
    expect(resolve('ultracode', claude, codex)).toBe('ultra')
    expect(resolve('max', claude, codex)).toBe('max')
  })

  it('ranks a remembered Ultracode with Ultra when the previous model is unknown', () => {
    const codex = reasoningModel(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium')
    const luna = reasoningModel(['low', 'medium', 'high', 'xhigh', 'max'], 'medium')

    expect(resolveReasoningEffort({ currentEffort: 'ultracode', nextModel: codex })).toBe('ultra')
    expect(resolveReasoningEffort({ currentEffort: 'ultracode', nextModel: luna })).toBe('max')
  })
})
