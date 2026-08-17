// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { workedFor } from './Thread.js'

describe('workedFor', () => {
  it.each([
    [0, '1s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [61_000, '1m 1s'],
    [3_661_000, '1h 1m 1s'],
    [86_400_000, '1d'],
    [437_471_000, '5d 1h 31m 11s'],
  ])('formats %i milliseconds as %s', (milliseconds, expected) => {
    expect(workedFor(milliseconds)).toBe(expected)
  })
})
