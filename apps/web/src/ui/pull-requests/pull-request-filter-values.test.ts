import { describe, expect, it } from 'vitest'
import { countPullRequestFilterValues } from './pull-request-filter-values.js'

describe('countPullRequestFilterValues', () => {
  it('counts matching values in one pass while retaining empty values in the total', () => {
    const result = countPullRequestFilterValues(
      [
        { repository: 'alpha', approved: true },
        { repository: 'alpha', approved: true },
        { repository: 'beta', approved: false },
        { repository: '', approved: true },
      ],
      (item) => item.approved,
      (item) => item.repository,
    )

    expect(result.total).toBe(3)
    expect(Object.fromEntries(result.byValue)).toEqual({ alpha: 2 })
  })
})
