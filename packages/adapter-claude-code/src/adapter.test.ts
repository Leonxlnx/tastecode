import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, CLAUDE_MODELS } from './adapter.js'

describe('Claude Code model list', () => {
  it('offers the documented --model aliases with Automatic as default', async () => {
    const adapter = new ClaudeCodeAdapter()
    expect(await adapter.listModels()).toMatchObject([
      { id: '', displayName: 'Automatic', isDefault: true },
      { id: 'fable', displayName: 'Fable' },
      { id: 'opus', displayName: 'Opus' },
      { id: 'sonnet', displayName: 'Sonnet' },
      { id: 'haiku', displayName: 'Haiku' },
    ])
  })

  it('marks exactly one model as the default', () => {
    expect(CLAUDE_MODELS.filter((model) => model.isDefault)).toHaveLength(1)
  })
})
