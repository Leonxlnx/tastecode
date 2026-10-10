import { describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import {
  choicesFor,
  customModelChoice,
  customModelKey,
  filterModelChoicesByQuery,
  isCustomModelChoice,
  modelVisibleByDefault,
  providerDisplayName,
  resolveReasoningEffort,
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
    const choice = customModelChoice({
      provider: 'codex',
      modelId: 'qwen-max',
      displayName: 'Qwen Max',
    })
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
    const codex = customModelChoice({ provider: 'codex', modelId: 'qwen-max', displayName: '' })
    const grok = customModelChoice({
      provider: 'grok',
      modelId: 'qwen-max',
      displayName: 'Qwen Max',
    })
    expect(codex.model.displayName).toBe('qwen-max')
    expect(codex.key).not.toBe(grok.key)
    expect(providerDisplayName('codex')).toBe('Codex')
    expect(providerDisplayName('claude-code')).toBe('Claude Code')
  })

  it('canonicalizes stock provider sources', () => {
    const direct = choicesFor({ provider: 'claude-code', sourceName: 'Claude', mark: 'grok' }, [
      model,
    ])[0]

    expect(direct).toMatchObject({ sourceName: 'Claude Code', mark: 'anthropic' })
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

  it('can omit a fake fallback when discovery is authoritative', () => {
    expect(
      choicesFor(
        {
          provider: 'grok',
          sourceName: 'Work Grok',
          mark: 'grok',
          agent: { id: 'work-grok', name: 'Work Grok' },
        },
        [],
        false,
      ),
    ).toEqual([])
  })

  it('filters model choices by case-insensitive words from their visible name or id', () => {
    const choices = choicesFor(
      { provider: 'claude-code', sourceName: 'Claude', mark: 'anthropic' },
      [
        { ...model, id: 'claude-opus-5', displayName: 'Opus 5' },
        { ...model, id: 'claude-sonnet-5', displayName: 'Sonnet 5' },
      ],
    )

    expect(filterModelChoicesByQuery(choices, 'OPUS claude')).toEqual([choices[0]])
    expect(filterModelChoicesByQuery(choices, 'sonnet-5')).toEqual([choices[1]])
    expect(filterModelChoicesByQuery(choices, '  ')).toBe(choices)
  })

  it.each([
    ['gpt-6-astra', true],
    ['gpt-6-sol', false],
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
    ['haiku', false],
    ['claude-haiku-4-5', false],
    ['CLAUDE-HAIKU-4-5[1m]', false],
    ['claude-opus-4-5', false],
    ['claude-opus-4-7', false],
    ['claude-opus-4-6', false],
    ['claude-sonnet-4-6', false],
    ['grok-4.5', true],
    ['grok-4.6', true],
    ['grok-4.7', true],
    ['grok-4.7-build-fast', false],
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
