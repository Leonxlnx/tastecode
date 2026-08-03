import { describe, expect, it } from 'vitest'
import { agentMark, choicesFor } from './model-catalog.js'

const model = {
  id: 'shared-model',
  displayName: 'Shared model',
  isDefault: true,
  reasoningEfforts: [],
  serviceTiers: [],
}

describe('model catalog', () => {
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

  it.each([
    ['gemini', 'gemini'],
    ['kimi', 'kimi'],
    ['qwen', 'qwen'],
    ['another-agent', 'acp'],
  ] as const)('uses the correct mark for %s', (agent, mark) => {
    expect(agentMark(agent)).toBe(mark)
  })
})
