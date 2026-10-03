import { describe, expect, it, vi } from 'vitest'
import { PullRequestService, type GhRunner } from './pull-requests.js'

const inspected = { headRefOid: 'head-a', baseRefOid: 'base-a' }

function setup() {
  let current = { ...inspected }
  let duringRetrieval: (() => void) | undefined
  const run = vi.fn<GhRunner>(async (args) => {
    if (args.at(-1) === 'headRefOid,baseRefOid') return JSON.stringify(current)
    if (args[1]?.includes('/files?')) {
      duringRetrieval?.()
      return JSON.stringify([
        {
          sha: 'blob',
          filename: 'src/example.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-old\n+new',
        },
      ])
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  })
  return {
    service: new PullRequestService({ run }),
    run,
    change: (field: 'headRefOid' | 'baseRefOid') => {
      current = { ...current, [field]: 'moved' }
    },
    during: (callback: () => void) => {
      duringRetrieval = callback
    },
    comparison: () => ({ ...current }),
  }
}

describe('pull-request file comparison binding', () => {
  it.each(['headRefOid', 'baseRefOid'] as const)(
    'rejects a changed %s before reading patches',
    async (field) => {
      const fixture = setup()
      fixture.change(field)
      await expect(fixture.service.files('owner/repo', 7, inspected)).rejects.toThrow(
        'Pull request comparison changed',
      )
      expect(fixture.run).toHaveBeenCalledOnce()
    },
  )

  it.each(['headRefOid', 'baseRefOid'] as const)(
    'discards patches if %s changes during retrieval',
    async (field) => {
      const fixture = setup()
      fixture.during(() => fixture.change(field))
      await expect(fixture.service.files('owner/repo', 7, inspected)).rejects.toThrow(
        'Pull request comparison changed',
      )
      expect(fixture.run).toHaveBeenCalledTimes(3)
      await expect(fixture.service.files('owner/repo', 7, inspected)).rejects.toThrow(
        'Pull request comparison changed',
      )
      expect(fixture.run).toHaveBeenCalledTimes(4)
    },
  )

  it('returns verified identity and never reuses another comparison cache entry', async () => {
    const fixture = setup()
    expect(await fixture.service.files('owner/repo', 7, inspected)).toMatchObject(inspected)
    await fixture.service.files('owner/repo', 7, inspected)
    expect(fixture.run).toHaveBeenCalledTimes(3)
    fixture.change('baseRefOid')
    const next = fixture.comparison()
    expect(await fixture.service.files('owner/repo', 7, next)).toMatchObject(next)
    expect(fixture.run).toHaveBeenCalledTimes(6)
  })

  it('rejects later pages rather than mixing comparisons', async () => {
    const fixture = setup()
    await fixture.service.files('owner/repo', 7, inspected, 1)
    fixture.change('headRefOid')
    await expect(fixture.service.files('owner/repo', 7, inspected, 2)).rejects.toThrow(
      'Pull request comparison changed',
    )
    expect(fixture.run.mock.calls.filter(([args]) => args[1]?.includes('/files?'))).toHaveLength(1)
  })
})
