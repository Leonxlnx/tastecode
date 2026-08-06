import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, CLAUDE_MODELS } from './adapter.js'

describe('Claude Code model list', () => {
  it('offers the documented --model aliases under full versioned names', async () => {
    const adapter = new ClaudeCodeAdapter()
    expect(await adapter.listModels()).toMatchObject([
      { id: 'fable', displayName: 'Fable 5', isDefault: true },
      { id: 'opus', displayName: 'Opus 5' },
      { id: 'sonnet', displayName: 'Sonnet 5' },
      { id: 'haiku', displayName: 'Haiku 4.5' },
    ])
  })

  it('marks exactly one model as the default', () => {
    expect(CLAUDE_MODELS.filter((model) => model.isDefault)).toHaveLength(1)
  })
})
