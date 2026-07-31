import { describe, expect, it } from 'vitest'
import { supportsApprovalMode } from './adapters.js'

describe('provider approval capabilities', () => {
  it('only accepts automatic review for providers that advertise it', () => {
    expect(supportsApprovalMode('codex', 'auto-review')).toBe(true)
    expect(supportsApprovalMode('claude-code', 'auto-review')).toBe(false)
    expect(supportsApprovalMode('acp', 'auto-review')).toBe(false)
  })

  it('keeps every existing approval mode available', () => {
    for (const provider of ['codex', 'claude-code', 'acp'] as const) {
      expect(supportsApprovalMode(provider, 'ask')).toBe(true)
      expect(supportsApprovalMode(provider, 'auto')).toBe(true)
      expect(supportsApprovalMode(provider, 'full')).toBe(true)
    }
  })
})
