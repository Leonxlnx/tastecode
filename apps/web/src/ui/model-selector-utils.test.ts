import { describe, expect, it } from 'vitest'
import { getEffortWord, getFriendlyEffortLabel } from './model-selector-utils.js'

describe('getEffortWord', () => {
  it('writes each level as one word in sentence case for the ledger', () => {
    expect(getEffortWord('xhigh')).toBe('Extra high')
    expect(getEffortWord('xlow')).toBe('Extra low')
    expect(getEffortWord('max')).toBe('Max')
    expect(getEffortWord('ultra')).toBe('Ultra')
    expect(getEffortWord('minimal')).toBe('Minimal')
    expect(getEffortWord('very_high')).toBe('Very high')
    expect(getEffortWord(undefined)).toBe('Default')
  })

  it('leaves the list and rail labels in title case', () => {
    expect(getFriendlyEffortLabel('xhigh')).toBe('Extra High')
  })
})
