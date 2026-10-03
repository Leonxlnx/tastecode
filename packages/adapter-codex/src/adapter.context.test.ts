import { describe, expect, it } from 'vitest'
import { codexContextConfig } from './adapter.js'

describe('codexContextConfig', () => {
  it('leaves Codex on its own defaults without a setting', () => {
    expect(codexContextConfig(undefined)).toEqual({})
    expect(codexContextConfig({})).toEqual({})
  })

  it('passes a chosen window through as the context window override', () => {
    expect(codexContextConfig({ window: 872_000 })).toEqual({ model_context_window: 872_000 })
  })

  it('counts the compaction point in tokens of the window it applies to', () => {
    expect(codexContextConfig({ window: 872_000, compactAt: 50 })).toEqual({
      model_context_window: 872_000,
      model_auto_compact_token_limit: 436_000,
    })
    expect(codexContextConfig({ compactAt: 75 })).toEqual({
      model_auto_compact_token_limit: 204_000,
    })
  })

  it('has no off switch to translate', () => {
    expect(codexContextConfig({ compactAt: 'off' })).toEqual({})
  })
})
