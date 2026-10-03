import { describe, expect, it } from 'vitest'
import { claudeContextEnvironment } from './adapter.js'

describe('claudeContextEnvironment', () => {
  it('adds nothing to the environment without a setting', () => {
    expect(claudeContextEnvironment(undefined)).toEqual({})
    expect(claudeContextEnvironment({})).toEqual({})
  })

  it('names the window and the compaction point the way Claude Code reads them', () => {
    expect(claudeContextEnvironment({ window: 1_000_000, compactAt: 70 })).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70',
    })
  })

  it('switches only automatic compaction off, so /compact keeps working', () => {
    const environment = claudeContextEnvironment({ compactAt: 'off' })
    expect(environment).toEqual({ DISABLE_AUTO_COMPACT: '1' })
    expect(environment).not.toHaveProperty('DISABLE_COMPACT')
  })
})
