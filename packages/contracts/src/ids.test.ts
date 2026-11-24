import { describe, expect, it } from 'vitest'
import * as ids from './ids.js'
import * as root from './index.js'

describe('ids entry', () => {
  it('is re-exported by the root entry as the same values', () => {
    expect(Object.keys(ids).sort()).toEqual([
      'AccountIdSchema',
      'DEFAULT_ACCOUNT_ID',
      'ProviderIdSchema',
    ])
    for (const [name, value] of Object.entries(ids)) {
      expect(root[name as keyof typeof root]).toBe(value)
    }
  })
})
