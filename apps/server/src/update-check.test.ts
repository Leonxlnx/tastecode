import { describe, expect, it } from 'vitest'
import { checkForUpdates } from './update-check.js'

describe('checkForUpdates', () => {
  it('reports up to date when local and remote agree', async () => {
    const result = await checkForUpdates({
      head: async () => 'abc123',
      fetchLatest: async () => ({ sha: 'abc123', message: 'tip', date: '2026-08-07' }),
    })
    expect(result).toEqual({
      localCommit: 'abc123',
      remote: { sha: 'abc123', message: 'tip', date: '2026-08-07' },
      upToDate: true,
    })
  })

  it('reports an update without claiming certainty it cannot have', async () => {
    // No local commit (packaged build): remote is shown, upToDate is absent —
    // claiming either verdict would be a guess.
    const result = await checkForUpdates({
      head: async () => undefined,
      fetchLatest: async () => ({ sha: 'def456', message: 'newer', date: '2026-08-07' }),
    })
    expect(result.upToDate).toBeUndefined()
    expect(result.remote?.sha).toBe('def456')
    expect(result.localCommit).toBeUndefined()
  })

  it('degrades to a readable error when GitHub is unreachable', async () => {
    const result = await checkForUpdates({
      head: async () => 'abc123',
      fetchLatest: async () => {
        throw new Error('offline')
      },
    })
    expect(result).toEqual({ localCommit: 'abc123', error: 'Could not reach GitHub.' })
  })
})
