import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeLimits, mapClaudeUsage } from './limits.js'

let configDir: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (configDir) await rm(configDir, { recursive: true, force: true })
  configDir = undefined
})

async function credentials(body: unknown): Promise<string> {
  configDir = await mkdtemp(join(tmpdir(), 'harness-claude-limits-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
  const path = join(configDir, '.credentials.json')
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

describe('mapClaudeUsage', () => {
  it('maps the session and weekly windows with reset times', () => {
    const rows = mapClaudeUsage({
      five_hour: { utilization: 42.5, resets_at: '2026-08-11T10:00:00Z' },
      seven_day: { utilization: '80', resets_at: '2026-08-14T00:00:00Z' },
    })
    expect(rows).toEqual([
      { label: 'Session', usedPercent: 42.5, resetsAt: Date.parse('2026-08-11T10:00:00Z') },
      { label: 'Weekly', usedPercent: 80, resetsAt: Date.parse('2026-08-14T00:00:00Z') },
    ])
  })

  it('clamps runaway utilization and skips windows without a number', () => {
    const rows = mapClaudeUsage({
      five_hour: { utilization: 130 },
      seven_day: { utilization: 'soon' },
      seven_day_sonnet: { utilization: '   ' },
    })
    expect(rows).toEqual([{ label: 'Session', usedPercent: 100 }])
  })

  it('adds per-model weekly windows from the limits array without duplicating', () => {
    const rows = mapClaudeUsage({
      seven_day: { utilization: 10 },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 55,
          resets_at: '2026-08-14T00:00:00Z',
          scope: { model: { display_name: 'fable' } },
        },
        { kind: 'session', percent: 99 },
        { kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'fable' } } },
        { kind: 'weekly_scoped', percent: 3, scope: { model: { display_name: ' ' } } },
      ],
    })
    expect(rows).toEqual([
      { label: 'Weekly', usedPercent: 10 },
      { label: 'Fable weekly', usedPercent: 55, resetsAt: Date.parse('2026-08-14T00:00:00Z') },
      { label: 'Model weekly', usedPercent: 3 },
    ])
  })

  it('returns nothing for junk bodies', () => {
    expect(mapClaudeUsage(undefined)).toEqual([])
    expect(mapClaudeUsage('nope')).toEqual([])
    expect(mapClaudeUsage({})).toEqual([])
  })

  it('ignores malformed credentials without making a request', async () => {
    await credentials('{not-json')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimits()).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('merge-saves a rotated refresh token and clears stale expiry metadata', async () => {
    const path = await credentials({
      theme: 'dark',
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
        accountUuid: 'account-1',
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
        new Response(JSON.stringify({ five_hour: { utilization: 25 } }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimits()).resolves.toEqual([{ label: 'Session', usedPercent: 25 }])
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(saved['theme']).toBe('dark')
    expect(saved['claudeAiOauth']).toEqual({
      accessToken: 'new-access',
      refreshToken: 'rotated-refresh',
      accountUuid: 'account-1',
    })
  })
})
