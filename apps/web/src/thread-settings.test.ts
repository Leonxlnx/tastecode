import { describe, expect, it } from 'vitest'
import type { Model } from '@harness/contracts'
import { modelChoiceKey, type ModelChoice } from './model-catalog.js'
import { adoptedSelection, modelIdFromKey, sharedSetup } from './thread-settings.js'

const model = (id: string): Model => ({
  id,
  displayName: id,
  isDefault: false,
  reasoningEfforts: ['low', 'high'],
  serviceTiers: [],
})

const choice = (id: string, provider: ModelChoice['provider'] = 'codex'): ModelChoice => ({
  key: modelChoiceKey(provider, id),
  provider,
  sourceName: provider,
  mark: 'openai',
  model: model(id),
})

describe('a chat setup shared through the server', () => {
  it('reads the model id back out of a choice key', () => {
    expect(modelIdFromKey(modelChoiceKey('codex', 'gpt-5.5/fast'))).toBe('gpt-5.5/fast')
    expect(modelIdFromKey(modelChoiceKey('acp:kimi', ''))).toBe('')
    expect(sharedSetup({ modelKey: 'codex:gpt-5.5', effort: 'high', designMode: true })).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
    })
  })

  it('follows a setup another client chose, keeping what only this window has', () => {
    const choices = [choice('gpt-5.5'), choice('gpt-5.5-mini')]
    const saved = { modelKey: 'codex:gpt-5.5', effort: 'high', designMode: true }
    expect(
      adoptedSelection(
        { model: 'gpt-5.5-mini', effort: 'low' },
        saved,
        { provider: 'codex' },
        choices,
      ),
    ).toEqual({ modelKey: 'codex:gpt-5.5-mini', effort: 'low', designMode: true })
    // Exactly what the window shows already: nothing to do, so nothing echoes back.
    expect(
      adoptedSelection({ model: 'gpt-5.5', effort: 'high' }, saved, { provider: 'codex' }, choices),
    ).toBeUndefined()
    // A chat nobody chose a model for keeps the window's own fallback.
    expect(adoptedSelection({ approval: 'auto' }, saved, { provider: 'codex' }, choices)).toBe(
      undefined,
    )
  })

  it('names a model the window does not list in the chat’s own source', () => {
    expect(
      adoptedSelection({ model: 'kimi-k3' }, undefined, { provider: 'acp', agent: 'kimi' }, []),
    ).toEqual({ modelKey: 'acp:kimi:kimi-k3' })
  })
})
