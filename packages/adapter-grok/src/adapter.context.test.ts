import { describe, expect, it } from 'vitest'
import { grokContextEnvironment } from './adapter.js'

describe('grokContextEnvironment', () => {
  it('leaves the inherited environment alone without a compaction point', () => {
    expect(grokContextEnvironment(undefined)).toBeUndefined()
    expect(grokContextEnvironment({})).toBeUndefined()
    expect(grokContextEnvironment({ window: 256_000 })).toBeUndefined()
  })

  it('hands Grok the compaction point as a percent of its window', () => {
    expect(grokContextEnvironment({ compactAt: 65 })).toEqual({
      GROK_AUTO_COMPACT_THRESHOLD_PERCENT: '65',
    })
  })
})
