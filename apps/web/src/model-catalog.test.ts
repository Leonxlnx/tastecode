import { describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import {
  agentMark,
  choicesFor,
  customModelChoice,
  customModelKey,
  filterModelChoicesByQuery,
  isCustomModelChoice,
  migrateHiddenModels,
  MODEL_VISIBILITY_VERSION,
  modelVisibleByDefault,
  providerDisplayName,
  resolveReasoningEffort,
  sourceKey,
  unlistedHiddenModels,
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

  it.each([
    ['gpt-6-astra', true],
    ['gpt-6-luna', true],
    ['gpt-6.1-sol', true],
    ['gpt-daybreak-blue-latest', true],
    ['gpt-5.6-sol', false],
    ['gpt-5.6-terra', false],
    ['gpt-5.6-luna', false],
    ['gpt-5.3-codex-spark', false],
    ['gpt-5.2', false],
    ['gpt-5.5', false],
    ['gpt-5.4', false],
    ['gpt-5.4-mini', false],
    ['fable', true],
    ['claude-fable-5', false],
    ['claude-fable-5-1', true],
    ['claude-fable-5-1[1m]', true],
    ['opus', true],
    ['claude-opus-5', false],
    ['claude-opus-5-5', true],
    ['sonnet', true],
    ['claude-sonnet-5', false],
    ['claude-sonnet-5-5', true],
    ['claude-opus-4-8', false],
    ['haiku', true],
    ['claude-haiku-5-5', true],
    ['claude-haiku-4-5', false],
    ['claude-haiku-4-5-20251001', false],
    ['CLAUDE-HAIKU-4-5[1m]', false],
    ['claude-haiku-5-5-20261001', true],
    ['claude-opus-4-5', false],
    ['claude-opus-4-7', false],
    ['claude-opus-4-6', false],
    ['claude-opus-4-20250514', false],
    ['claude-sonnet-4-6', false],
    ['claude-sonnet-4-5-20250929', false],
    ['claude-opus-6', true],
    ['claude-sonnet-5-6', true],
    ['claude-mythos-1', true],
    ['grok-4.5', true],
    ['grok-4.6', true],
    ['grok-4.7', true],
    ['grok-4.7-build-fast', false],
    ['provider-model-added-tomorrow', true],
  ])('defaults %s visibility to %s', (id, visible) => {
    expect(modelVisibleByDefault({ ...model, id })).toBe(visible)
  })

  it('starts only never-listed older models hidden, and none without a record', () => {
    const choices = choicesFor(
      { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
      ['opus', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-6'].map((id) => ({ ...model, id })),
    )
    const listed = new Set(['claude-code:opus', 'claude-code:claude-opus-4-8'])

    expect(unlistedHiddenModels(choices, listed).map((choice) => choice.key)).toEqual([
      'claude-code:claude-opus-5',
    ])
    expect(unlistedHiddenModels(choices, null)).toEqual([])
  })

  describe('model visibility migration', () => {
    const claudeChoices = choicesFor(
      { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
      ['opus', 'haiku', 'claude-opus-4-8', 'claude-fable-5'].map((id) => ({ ...model, id })),
    )
    // Haiku was hidden by the old defaults; the user also hid Opus 5.5 and
    // re-enabled Opus 4.8 by hand. A key outside this catalog stays as saved.
    const saved = new Set([
      'claude-code:haiku',
      'claude-code:opus',
      'claude-code:claude-fable-5',
      'codex:gpt-5.5',
    ])

    it.each([null, '3', 'unknown'])('resets every listed model for version %s', (version) => {
      expect([...migrateHiddenModels(saved, version, claudeChoices)].sort()).toEqual([
        'claude-code:claude-fable-5',
        'claude-code:claude-opus-4-8',
        'codex:gpt-5.5',
      ])
    })

    // A real catalog, as an installed build cached it on 2026-10-13: Claude
    // Code lists the current lineup under its aliases and every older
    // generation under its own id, Haiku 4.5 only as a dated snapshot.
    const named = (entries: [id: string, displayName: string][]) =>
      entries.map(([id, displayName]) => ({ ...model, id, displayName }))
    const catalog = [
      ...choicesFor(
        { provider: 'claude-code', sourceName: 'Claude Code', mark: 'anthropic' },
        named([
          ['fable', 'Fable 5.1'],
          ['opus', 'Opus 5.5'],
          ['sonnet', 'Sonnet 5.5'],
          ['haiku', 'Haiku 5.5'],
          ['claude-fable-5', 'Fable 5'],
          ['claude-opus-5', 'Opus 5'],
          ['claude-sonnet-5', 'Sonnet 5'],
          ['claude-opus-4-8', 'Opus 4.8'],
          ['claude-opus-4-7', 'Opus 4.7'],
          ['claude-opus-4-6', 'Opus 4.6'],
          ['claude-opus-4-5', 'Opus 4.5'],
          ['claude-sonnet-4-6', 'Sonnet 4.6'],
          ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
        ]),
      ),
      ...choicesFor(
        { provider: 'codex', sourceName: 'Codex', mark: 'openai' },
        named([
          ['gpt-6-astra', 'GPT-6-Astra'],
          ['gpt-5.6-sol', 'GPT-5.6-Sol'],
          ['gpt-5.5', 'GPT-5.5'],
        ]),
      ),
      ...choicesFor(
        { provider: 'grok', sourceName: 'Grok', mark: 'grok' },
        named([
          ['grok-4.7', 'Grok 4.7'],
          ['grok-4.7-build-fast', 'Grok 4.7 Build Fast'],
        ]),
      ),
      ...choicesFor(
        {
          provider: 'claude-code',
          sourceName: 'Work Claude',
          mark: 'anthropic',
          agent: { id: 'work-claude', name: 'Work Claude' },
        },
        named([['claude-opus-4-8', 'Opus 4.8']]),
      ),
    ]
    const visible = (hidden: ReadonlySet<string>, source: string) =>
      catalog
        .filter(
          (choice) =>
            sourceKey({ provider: choice.provider, agentId: choice.agent?.id }) === source &&
            !hidden.has(choice.key),
        )
        .map((choice) => choice.model.displayName)
    // Abridged from the list that build saved at version 4: the `sonnet` and
    // `haiku` aliases hidden by an older default, Opus 5, Sonnet 5 and Haiku
    // 4.5 never hidden, Sol turned back on by hand, keys of models no longer
    // listed. The custom Claude harness row stands for a user-owned source.
    const savedByOlderBuild = [
      'codex:gpt-5.5',
      'codex:gpt-5.4',
      'claude-code:claude-fable-5',
      'claude-code:sonnet',
      'claude-code:haiku',
      'claude-code:claude-opus-4-8',
      'claude-code:claude-opus-4-7',
      'claude-code:claude-opus-4-6',
      'claude-code:claude-opus-4-5',
      'claude-code:claude-sonnet-4-6',
      'claude-code:opus%5B1m%5D',
      'claude-code:work-claude:claude-opus-4-8',
    ]
    const savedStates: [label: string, hidden: string[]][] = [
      ['the list an older build saved', savedByOlderBuild],
      ['nothing hidden', []],
      [
        'the aliases hidden and the older rows shown',
        ['claude-code:fable', 'claude-code:opus', 'claude-code:sonnet', 'claude-code:haiku'],
      ],
    ]
    const currentLineup = ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']

    it.each(
      savedStates.flatMap(([label, hidden]) =>
        ['4', '5', '6'].map((version) => [label, version, hidden] as const),
      ),
    )(
      'returns Claude Code to the current lineup from %s at version %s',
      (_label, version, hidden) => {
        const migrated = migrateHiddenModels(new Set(hidden), version, catalog)

        expect(visible(migrated, 'claude-code')).toEqual(currentLineup)
      },
    )

    it.each(['4', '5', '6'])(
      "keeps every other source's choices when migrating from version %s",
      (version) => {
        const saved = new Set(savedByOlderBuild)
        const migrated = migrateHiddenModels(saved, version, catalog)

        expect(visible(migrated, 'codex')).toEqual(['GPT-6-Astra', 'GPT-5.6-Sol'])
        expect(visible(migrated, 'grok')).toEqual(['Grok 4.7', 'Grok 4.7 Build Fast'])
        expect(migrated.has('claude-code:work-claude:claude-opus-4-8')).toBe(true)
        // Keys of models the catalog no longer lists stay as saved.
        expect(migrated.has('codex:gpt-5.4')).toBe(true)
        expect(migrated.has('claude-code:opus%5B1m%5D')).toBe(true)
      },
    )

    it('keeps an older model turned back on once the profile is current', () => {
      const migrated = migrateHiddenModels(new Set(savedByOlderBuild), '4', catalog)
      migrated.delete('claude-code:claude-opus-5')

      expect(migrateHiddenModels(migrated, MODEL_VISIBILITY_VERSION, catalog)).toEqual(migrated)
      expect(visible(migrated, 'claude-code')).toEqual([...currentLineup, 'Opus 5'])
    })

    it('leaves a current profile untouched', () => {
      expect(migrateHiddenModels(saved, MODEL_VISIBILITY_VERSION, claudeChoices)).toEqual(saved)
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
