import { describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import {
  agentMark,
  choicesFor,
  customModelChoice,
  customModelKey,
  filterModelChoicesByQuery,
  isCustomModelChoice,
  modelVisibleByDefault,
  providerDisplayName,
  resolveReasoningEffort,
} from './model-catalog.js'
import { propertiesWhen } from './properties-when.js'

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
    ...propertiesWhen(defaultReasoningEffort, (defaultReasoningEffort) => ({
      defaultReasoningEffort,
    })),
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
    ['gpt-5.6-sol', true],
    ['gpt-5.6-terra', true],
    ['gpt-5.6-luna', true],
    ['gpt-5.3-codex-spark', true],
    ['gpt-5.5', false],
    ['gpt-5.4', false],
    ['gpt-5.4-mini', false],
    ['fable', true],
    ['opus', true],
    ['sonnet', true],
    ['claude-opus-4-8', true],
    ['haiku', false],
    ['claude-opus-4-7', false],
    ['claude-opus-4-6', false],
    ['claude-sonnet-4-6', false],
    ['grok-4.5', true],
    ['grok-4.6', true],
    ['provider-model-added-tomorrow', true],
  ])('defaults %s visibility to %s', (id, visible) => {
    expect(modelVisibleByDefault({ ...model, id })).toBe(visible)
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
})
