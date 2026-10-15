import { describe, expect, it } from 'vitest'
import { APPROVAL_MODES } from './approval-modes.js'

describe('approval mode copy', () => {
  // Shared UI serves every provider; a reviewer is a declared capability, not Codex.
  it('names no provider', () => {
    for (const mode of APPROVAL_MODES) {
      expect(`${mode.title} ${mode.short} ${mode.detail}`).not.toMatch(
        /codex|claude|grok|cursor|opencode/i,
      )
    }
  })
})
