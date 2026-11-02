import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeLimitSource, mapClaudeRateLimitEvent, mapClaudeUsage } from './limits.js'
import type { ClaudeUsageQueryFactory } from './sdk-runtime.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Claude Code subscription limits', () => {
  it('maps every reported window and reset time', () => {
    expect(
      mapClaudeUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: '2026-08-22T10:00:00Z' },
          seven_day: { utilization: 80, resets_at: '2026-08-25T00:00:00Z' },
          seven_day_sonnet: { utilization: 0, resets_at: null },
          seven_day_opus: null,
          seven_day_oauth_apps: { utilization: null, resets_at: null },
          model_scoped: [
            { display_name: 'fable', utilization: 55, resets_at: '2026-08-26T00:00:00Z' },
          ],
          extra_usage: { is_enabled: true, utilization: 12 },
        },
      }),
    ).toEqual({
      status: 'ready',
      limits: [
        {
          id: 'five_hour',
          label: 'Session',
          usedPercent: 42.5,
          resetsAt: Date.parse('2026-08-22T10:00:00Z'),
          windowMinutes: 300,
        },
        {
          id: 'seven_day',
          label: 'Weekly',
          usedPercent: 80,
          resetsAt: Date.parse('2026-08-25T00:00:00Z'),
          windowMinutes: 10_080,
        },
        { id: 'seven_day_sonnet', label: 'Sonnet weekly', usedPercent: 0, windowMinutes: 10_080 },
        {
          id: 'model:fable',
          label: 'Fable weekly',
          usedPercent: 55,
          resetsAt: Date.parse('2026-08-26T00:00:00Z'),
          windowMinutes: 10_080,
        },
        { id: 'extra_usage', label: 'Extra usage', usedPercent: 12 },
      ],
    })
  })

  it('maps the rate limits Claude Code 2.1.296 reports today', () => {
    // Shape captured from get_usage with skipBehaviors on 2026-10-17, rate limits only.
    expect(
      mapClaudeUsage({
        rate_limits_available: true,
        subscription_type: 'max',
        rate_limits: {
          five_hour: {
            utilization: 49,
            resets_at: '2026-10-17T01:09:59.645762+00:00',
            used_dollars: null,
            limit_dollars: null,
            remaining_dollars: null,
            locked_reason: null,
          },
          seven_day: null,
          seven_day_oauth_apps: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_cowork: null,
          extra_usage: { is_enabled: false, utilization: null },
          limits: [
            { kind: 'session', group: 'session', percent: 49, is_active: true },
            { kind: 'weekly_scoped', group: 'weekly', percent: 0, is_active: false },
          ],
          model_scoped: [
            { display_name: 'Fable', utilization: 0, resets_at: '2026-10-23T06:00:00+00:00' },
          ],
        },
      }),
    ).toEqual({
      status: 'ready',
      limits: [
        {
          id: 'five_hour',
          label: 'Session',
          usedPercent: 49,
          resetsAt: Date.parse('2026-10-17T01:09:59.645762+00:00'),
          windowMinutes: 300,
        },
        {
          id: 'model:fable',
          label: 'Fable weekly',
          usedPercent: 0,
          resetsAt: Date.parse('2026-10-23T06:00:00+00:00'),
          windowMinutes: 10_080,
        },
      ],
    })
  })

  describe('live rate_limit_event windows', () => {
    // Captured from claude 2.1.296 during turns on 2026-10-12 to 2026-10-16. `utilization` is a
    // fraction and `resetsAt` epoch seconds; the top level carries utilization only near a limit.
    const captured = {
      allowed: {
        status: 'allowed',
        resetsAt: 1_792_119_600,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: 0.76, resetsAt: 1_792_119_600 } },
      },
      warning: {
        status: 'allowed_warning',
        resetsAt: 1_791_773_400,
        rateLimitType: 'five_hour',
        utilization: 0.93,
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
        surpassedThreshold: 0.9,
        unifiedWindows: { five_hour: { utilization: 0.93, resetsAt: 1_791_773_400 } },
        overageEnabled: false,
      },
    }
    const session = (usedPercent: number, resetsAt: number) => ({
      id: 'five_hour',
      label: 'Session',
      usedPercent,
      resetsAt: resetsAt * 1000,
      windowMinutes: 300,
    })

    it('maps captured events to the row the full read names five_hour', () => {
      expect(mapClaudeRateLimitEvent(captured.allowed)).toEqual([session(76, 1_792_119_600)])
      expect(mapClaudeRateLimitEvent(captured.warning)).toEqual([session(93, 1_791_773_400)])
    })

    it('maps every known window an event lists and leaves unknown ones to the full read', () => {
      expect(
        mapClaudeRateLimitEvent({
          status: 'allowed',
          unifiedWindows: {
            five_hour: { utilization: 0.2, resetsAt: 1_800_000_000 },
            seven_day: { utilization: 0.455, resetsAt: 1_800_400_000 },
            seven_day_overage_included: { utilization: 0.5, resetsAt: 1_800_400_000 },
            overage: { utilization: 0.1 },
            constructor: { utilization: 0.3 },
          },
        }),
      ).toEqual([
        session(20, 1_800_000_000),
        {
          id: 'seven_day',
          label: 'Weekly',
          usedPercent: 45.5,
          resetsAt: 1_800_400_000_000,
          windowMinutes: 10_080,
        },
      ])
    })

    it('reads the top-level window when an event lists no windows', () => {
      expect(
        mapClaudeRateLimitEvent({
          status: 'allowed_warning',
          rateLimitType: 'seven_day_opus',
          utilization: 0.91,
          resetsAt: 1_800_000_000,
        }),
      ).toEqual([
        {
          id: 'seven_day_opus',
          label: 'Opus weekly',
          usedPercent: 91,
          resetsAt: 1_800_000_000_000,
          windowMinutes: 10_080,
        },
      ])
      // Without a utilization there is no number to show.
      expect(
        mapClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1 }),
      ).toEqual([])
    })

    it('shows a refused window as used up when the event gives no utilization', () => {
      expect(
        mapClaudeRateLimitEvent({
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: 1_800_000_000,
        }),
      ).toEqual([session(100, 1_800_000_000)])
    })

    it('skips values in a unit the event does not use and malformed events', () => {
      expect(
        mapClaudeRateLimitEvent({
          status: 'allowed',
          unifiedWindows: { five_hour: { utilization: 76, resetsAt: 1_800_000_000 } },
        }),
      ).toEqual([])
      expect(mapClaudeRateLimitEvent(null)).toEqual([])
      expect(mapClaudeRateLimitEvent({ status: 'allowed', unifiedWindows: 'changed' })).toEqual([])
    })
  })

  it('clamps invalid percentages and deduplicates model windows', () => {
    expect(
      mapClaudeUsage({
        rate_limits_available: true,
        rate_limits: {
          seven_day_sonnet: { utilization: 130, resets_at: null },
          model_scoped: [
            { display_name: 'Sonnet', utilization: 20, resets_at: null },
            { display_name: ' ', utilization: 30, resets_at: null },
          ],
        },
      }),
    ).toEqual({
      status: 'ready',
      limits: [
        { id: 'seven_day_sonnet', label: 'Sonnet weekly', usedPercent: 100, windowMinutes: 10_080 },
      ],
    })
  })

  it('keeps non-subscription sessions unavailable', () => {
    expect(mapClaudeUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      status: 'unavailable',
    })
  })

  it('reports available limits that came back empty as a failed read', () => {
    // The same subscription answered with its windows on other reads; "no plan
    // limits" would hide them until the unavailable answer expired.
    expect(() => mapClaudeUsage({ rate_limits_available: true, rate_limits: null })).toThrow(
      'Claude did not report plan limits this time.',
    )
  })

  it('rejects malformed experimental responses', () => {
    expect(() => mapClaudeUsage({ rate_limits_available: true, rate_limits: 'changed' })).toThrow(
      'Claude usage response was invalid.',
    )
    expect(() =>
      mapClaudeUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 20, resets_at: 'not-a-date' } },
      }),
    ).toThrow('Claude usage response was invalid.')
  })

  it('reads usage through a short-lived SDK query and closes it', async () => {
    const close = vi.fn()
    const usage = vi.fn().mockResolvedValue({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: null } },
    } as SDKControlGetUsageResponse)
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
    }))

    await expect(claudeLimitSource({ createQuery })).resolves.toEqual({
      status: 'ready',
      limits: [{ id: 'five_hour', label: 'Session', usedPercent: 25, windowMinutes: 300 }],
    })
    // Plan limits never need the behaviors section, whose transcript scan
    // costs minutes on a long history.
    expect(usage).toHaveBeenCalledExactlyOnceWith({ skipBehaviors: true })
    expect(close).toHaveBeenCalledOnce()
    const input = createQuery.mock.calls[0]?.[0]
    expect(input?.options).toMatchObject({
      pathToClaudeCodeExecutable: 'claude',
      persistSession: false,
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
    })
    expect(input?.options.abortController?.signal.aborted).toBe(true)
  })

  it('turns off IDE and claude.ai connector startup work for the read only', async () => {
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close: vi.fn(),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi
        .fn()
        .mockResolvedValue({ rate_limits_available: false, rate_limits: null }),
    }))
    const environment: NodeJS.ProcessEnv = {
      PATH: 'fixture-path',
      CLAUDE_CONFIG_DIR: 'fixture-config',
      FORCE_CODE_TERMINAL: '1',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '1',
    }

    await claudeLimitSource({ createQuery, environment })

    const env = createQuery.mock.calls[0]?.[0].options.env
    expect(env).toEqual({
      PATH: 'fixture-path',
      CLAUDE_CONFIG_DIR: 'fixture-config',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    })
    // The caller's environment, and with it every chat session, is untouched.
    expect(environment).toEqual({
      PATH: 'fixture-path',
      CLAUDE_CONFIG_DIR: 'fixture-config',
      FORCE_CODE_TERMINAL: '1',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '1',
    })
  })

  it('closes a failed query and reports a stable error', async () => {
    const close = vi.fn()
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi
        .fn()
        .mockRejectedValue(new Error('private detail')),
    }))

    // A failure is not a missed deadline; only deadlines count toward giving up.
    await expect(claudeLimitSource({ createQuery })).rejects.toMatchObject({
      name: 'Error',
      message: 'Claude usage request failed.',
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('waits for a usage answer that arrives behind a slow CLI start', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    // A slow machine can take several seconds to start the CLI before it answers.
    const usage = vi.fn(
      () =>
        new Promise<SDKControlGetUsageResponse>((resolve) =>
          setTimeout(
            () =>
              resolve({
                rate_limits_available: true,
                rate_limits: { five_hour: { utilization: 40, resets_at: null } },
              } as SDKControlGetUsageResponse),
            19_999,
          ),
        ),
    )
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
    }))

    const read = claudeLimitSource({ createQuery })
    await vi.advanceTimersByTimeAsync(19_999)

    await expect(read).resolves.toEqual({
      status: 'ready',
      limits: [{ id: 'five_hour', label: 'Session', usedPercent: 40, windowMinutes: 300 }],
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('cuts off a stuck usage request with a stable timeout message', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const createQuery = vi.fn<ClaudeUsageQueryFactory>(() => ({
      close,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
    }))

    const read = claudeLimitSource({ createQuery })
    let settled = false
    const rejected = expect(
      read.finally(() => {
        settled = true
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError', message: 'Claude usage request timed out.' })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(settled).toBe(false)
    // An older CLI ignores the skip option and scans; it must not run for minutes.
    await vi.advanceTimersByTimeAsync(1)

    await rejected
    expect(close).toHaveBeenCalledOnce()
    expect(createQuery.mock.calls[0]?.[0].options.abortController?.signal.aborted).toBe(true)
  })

  it('keeps provider-owned credentials and private OAuth APIs out of production sources', async () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url))
    const names = (await readdir(sourceDir)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
    const productionSource = (
      await Promise.all(names.map((name) => readFile(join(sourceDir, name), 'utf8')))
    ).join('\n')
    const forbidden = [
      '.creden' + 'tials.json',
      '/api/oauth/' + 'usage',
      '/v1/oauth/' + 'token',
      'refresh_' + 'token',
      'client_' + 'id',
      'claude-code/' + '2.',
    ]

    for (const marker of forbidden) expect(productionSource).not.toContain(marker)
  })
})
