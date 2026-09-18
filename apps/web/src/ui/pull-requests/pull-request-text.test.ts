import { describe, expect, it } from 'vitest'
import { comparePullRequestText, countLabel } from './pull-request-text.js'

describe('comparePullRequestText', () => {
  it('matches the previous case-insensitive locale ordering', () => {
    const values = ['zeta', 'Álpha 10', 'alpha 2', 'ALPHA 1', 'beta', 'ßeta']
    const legacy = values
      .slice()
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))

    expect(values.slice().sort(comparePullRequestText)).toEqual(legacy)
  })
})

describe('countLabel', () => {
  it.each([
    [0, '0 files'],
    [1, '1 file'],
    [2, '2 files'],
  ])('formats %i as %s', (count, expected) => {
    expect(countLabel(count, 'file')).toBe(expected)
  })
})
