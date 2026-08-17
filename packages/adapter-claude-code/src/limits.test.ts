import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonRpcValue } from '@harness/proc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { claudeLimitSource, claudeLimits, mapClaudeUsage } from './limits.js'

let configDir: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (configDir) await rm(configDir, { recursive: true, force: true })
  configDir = undefined
})

const SavedCredentialsSchema = z.object({
  theme: z.string().optional(),
  claudeAiOauth: z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    accountUuid: z.string().optional(),
  }),
})

async function credentials(body: JsonRpcValue): Promise<string> {
  configDir = await mkdtemp(join(tmpdir(), 'harness-claude-limits-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
  const path = join(configDir, '.credentials.json')
  const text = z.string().safeParse(body)
  await writeFile(path, text.success ? text.data : JSON.stringify(body), 'utf8')
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

  it('maps every recognized legacy weekly window, including valid zero usage', () => {
    expect(
      mapClaudeUsage({
        seven_day_opus: { utilization: 0 },
        seven_day_oauth_apps: { utilization: 25 },
      }),
    ).toEqual([
      { label: 'Opus weekly', usedPercent: 0 },
      { label: 'OAuth apps weekly', usedPercent: 25 },
    ])
  })

  it('returns nothing for junk bodies', () => {
    expect(mapClaudeUsage(undefined)).toEqual([])
    expect(mapClaudeUsage('nope')).toEqual([])
    expect(mapClaudeUsage({})).toEqual([])
  })

  it('marks an absent credential unavailable without making a request', async () => {
    configDir = await mkdtemp(join(tmpdir(), 'harness-claude-limits-'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimitSource()).resolves.toEqual({ status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('surfaces malformed or unreadable credentials without exposing their path', async () => {
    await credentials('{not-json')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimitSource()).rejects.toThrow('Claude credentials could not be parsed.')
    expect(fetch).not.toHaveBeenCalled()

    if (configDir) await rm(configDir, { recursive: true, force: true })
    configDir = await mkdtemp(join(tmpdir(), 'harness-claude-limits-'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
    await mkdir(join(configDir, '.credentials.json'))
    await expect(claudeLimitSource()).rejects.toThrow('Claude credentials could not be read.')
  })

  it('does not treat a present but invalid OAuth record as unconfigured', async () => {
    await credentials({ claudeAiOauth: { accessToken: ' ' } })
    vi.stubGlobal('fetch', vi.fn())

    await expect(claudeLimitSource()).rejects.toThrow('Claude credentials could not be parsed.')
  })

  it('sanitizes invalid optional OAuth fields before attempting refresh', async () => {
    await credentials({
      claudeAiOauth: {
        accessToken: 'test-access',
        refreshToken: 42,
        expiresAt: 0,
      },
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimitSource()).rejects.toThrow('Claude credentials could not be parsed.')
    expect(fetch).not.toHaveBeenCalled()

    if (configDir) await rm(configDir, { recursive: true, force: true })
    await credentials({ claudeAiOauth: { accessToken: 'test-access', expiresAt: 'soon' } })
    await expect(claudeLimitSource()).rejects.toThrow('Claude credentials could not be parsed.')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not collapse a failed usage response into an empty result', async () => {
    await credentials({
      claudeAiOauth: {
        accessToken: 'test-access',
        expiresAt: Date.now() + 60_000,
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    await expect(claudeLimits()).rejects.toThrow('Claude usage request failed (HTTP 503)')
  })

  it('rejects malformed successful responses but accepts known empty windows', async () => {
    await credentials({
      claudeAiOauth: {
        accessToken: 'test-access',
        expiresAt: Date.now() + 60_000,
      },
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ['new_shape']: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: 'broken' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ limits: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ limits: ['broken'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    for (let index = 0; index < 5; index += 1) {
      await expect(claudeLimitSource()).rejects.toThrow('Claude usage response was invalid.')
    }
    await expect(claudeLimitSource()).resolves.toEqual({ status: 'ready', limits: [] })
  })

  it('sanitizes invalid refresh response fields', async () => {
    await credentials({
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
      },
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('null', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 42 }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetch)

    await expect(claudeLimitSource()).rejects.toThrow(
      'Claude credential refresh response was invalid.',
    )
    await expect(claudeLimitSource()).rejects.toThrow(
      'Claude credential refresh response was invalid.',
    )
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
    const saved = SavedCredentialsSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    expect(saved.theme).toBe('dark')
    expect(saved.claudeAiOauth).toEqual({
      accessToken: 'new-access',
      refreshToken: 'rotated-refresh',
      accountUuid: 'account-1',
    })
  })
})
