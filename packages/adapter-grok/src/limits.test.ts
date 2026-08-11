import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grokLimits, mapGrokBilling } from './limits.js'

let grokHome: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (grokHome) await rm(grokHome, { recursive: true, force: true })
  grokHome = undefined
})

async function auth(body: unknown): Promise<string> {
  grokHome = await mkdtemp(join(tmpdir(), 'harness-grok-limits-'))
  vi.stubEnv('GROK_HOME', grokHome)
  const path = join(grokHome, 'auth.json')
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

describe('mapGrokBilling', () => {
  it('maps the weekly credit pool with its reset time', () => {
    const rows = mapGrokBilling({
      config: {
        creditUsagePercent: 99.2,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-04T00:00:00+00:00',
          end: '2026-08-11T00:00:00+00:00',
        },
        onDemandCap: { val: 2500 },
      },
    })
    expect(rows).toEqual([
      {
        label: 'Weekly limit',
        usedPercent: 99.2,
        resetsAt: Date.parse('2026-08-11T00:00:00+00:00'),
      },
    ])
  })

  it('treats a missing percent as zero used (proto3 omits zero fields)', () => {
    const rows = mapGrokBilling({
      config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } },
    })
    expect(rows).toEqual([{ label: 'Weekly limit', usedPercent: 0 }])
  })

  it('clamps finite percentages and rejects empty or non-finite values', () => {
    const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY' }
    expect(mapGrokBilling({ config: { creditUsagePercent: 140, currentPeriod: period } })).toEqual([
      { label: 'Weekly limit', usedPercent: 100 },
    ])
    expect(mapGrokBilling({ config: { creditUsagePercent: -4, currentPeriod: period } })).toEqual([
      { label: 'Weekly limit', usedPercent: 0 },
    ])
    expect(mapGrokBilling({ config: { creditUsagePercent: ' ', currentPeriod: period } })).toEqual(
      [],
    )
    expect(mapGrokBilling({ config: { creditUsagePercent: Number.NaN, currentPeriod: period } })).toEqual(
      [],
    )
  })

  it('emits nothing for non-weekly periods or junk', () => {
    expect(
      mapGrokBilling({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_DAILY' } } }),
    ).toEqual([])
    expect(mapGrokBilling({})).toEqual([])
    expect(mapGrokBilling(undefined)).toEqual([])
  })

  it('ignores malformed auth JSON without making a request', async () => {
    await auth('{not-json')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(grokLimits()).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('merge-saves rotated tokens without retaining expired metadata', async () => {
    const path = await auth({
      'person::client-1': {
        key: 'old-access',
        refresh: 'old-refresh',
        expires_at: '2000-01-01T00:00:00.000Z',
        label: 'primary',
      },
      'other::client-2': {
        key: 'other-access',
        refresh_token: 'other-refresh',
      },
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'rotated-refresh',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              creditUsagePercent: 12,
              currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
            },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)

    await expect(grokLimits()).resolves.toEqual([{ label: 'Weekly limit', usedPercent: 12 }])
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(saved['person::client-1']).toEqual({
      key: 'new-access',
      refresh: 'old-refresh',
      refresh_token: 'rotated-refresh',
      label: 'primary',
    })
    expect(saved['other::client-2']).toEqual({
      key: 'other-access',
      refresh_token: 'other-refresh',
    })
  })
})
