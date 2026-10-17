import { readFileSync } from 'node:fs'
import { JsonRpcError, type JsonRpcValue } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './adapter.js'
import { FakeCodexRpc } from './fake-rpc.test-support.js'
import { CodexLimitMemory } from './limits.js'

const proc = vi.hoisted(() => ({ rpc: undefined as FakeCodexRpc | undefined }))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnCli: vi.fn(() => ({ pid: 1 })),
  StdioJsonRpc: class {
    constructor() {
      if (!proc.rpc) throw new Error('fake Codex RPC was not installed')
      return proc.rpc
    }
  },
}))

type SourceState = {
  account: JsonRpcValue
  accountResponse?: JsonRpcValue
  failure?: string
  rateLimitsResponse?: JsonRpcValue
  consumeResponse?: JsonRpcValue
  /** What `initialize` reports as the app-server's home. */
  home?: string
}

const emptyRateLimits = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    planType: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
} as const

function sourceAdapter(
  initial: Partial<SourceState> = {},
  options: ConstructorParameters<typeof CodexAdapter>[0] = {},
) {
  const state: SourceState = { account: null, ...initial }
  const rpc = new FakeCodexRpc((method) => {
    if (method === state.failure) throw new Error(`${method} failed`)
    if (method === 'initialize' && state.home) return { codexHome: state.home }
    if (method === 'account/read') {
      return state.accountResponse ?? { account: state.account }
    }
    if (method === 'account/rateLimits/read') {
      return state.rateLimitsResponse ?? emptyRateLimits
    }
    if (method === 'account/rateLimitResetCredit/consume') {
      return state.consumeResponse ?? { outcome: 'reset' }
    }
    return {}
  })
  proc.rpc = rpc
  return { adapter: new CodexAdapter(options), rpc, state }
}

const capturedRateLimitUpdate = {
  rateLimits: emptyRateLimits.rateLimits,
}

describe('Codex rate-limit source', () => {
  it('bounds initialization and disposes a failed transport', async () => {
    const { adapter, rpc } = sourceAdapter({ failure: 'initialize' })

    await expect(adapter.start()).rejects.toThrow('initialize failed')
    expect(rpc.calls[0]).toMatchObject({ method: 'initialize', timeoutMs: 30_000 })
    expect(rpc.disposals).toBe(1)
  })

  it('handles only the exact provider update, and one without values changes nothing', async () => {
    const { adapter, rpc } = sourceAdapter({}, { limitMemory: new CodexLimitMemory() })
    const changed = vi.fn()
    const updated = vi.fn()
    const logged = vi.fn()
    adapter.on('usageChanged', changed)
    adapter.onLimitsUpdated(updated)
    adapter.on('log', logged)
    await adapter.start()

    rpc.emitNotification('account/rateLimits/updated', capturedRateLimitUpdate)

    expect(changed).not.toHaveBeenCalled()
    expect(updated).not.toHaveBeenCalled()
    expect(logged).not.toHaveBeenCalled()

    rpc.emitNotification('account/rateLimits/updated-v2', capturedRateLimitUpdate)
    expect(changed).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith('unmapped notification: account/rateLimits/updated-v2')
    adapter.dispose()
  })

  it('ignores a buffered usage update after disposal', async () => {
    const { adapter, rpc } = sourceAdapter()
    const changed = vi.fn()
    adapter.onUsageChanged(changed)
    await adapter.start()

    adapter.dispose()
    rpc.emitNotification('account/rateLimits/updated', capturedRateLimitUpdate)

    expect(changed).not.toHaveBeenCalled()
  })

  describe('rolling updates', () => {
    const chatgpt = { type: 'chatgpt', email: null, planType: 'pro' } as const
    // Captured from codex 0.163 `account/rateLimits/read` on 2026-10-17 (ids and balance replaced).
    const capturedRead = JSON.parse(
      readFileSync(
        new URL('./fixtures/rate-limits-read-codex-0.163.json', import.meta.url),
        'utf8',
      ),
    ) as JsonRpcValue
    // The 0.163 `AccountRateLimitsUpdatedNotification` shape, with the values Codex 0.163 wrote
    // to its own session log during real turns. A live frame needs a paid turn to capture.
    const rollingUpdate = JSON.parse(
      readFileSync(
        new URL('./fixtures/rate-limits-update-codex-0.163.json', import.meta.url),
        'utf8',
      ),
    ) as JsonRpcValue
    const sparkRead = {
      ...emptyRateLimits,
      rateLimitsByLimitId: {
        spark: {
          ...emptyRateLimits.rateLimits,
          limitId: 'spark',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
        },
      },
    }
    const sparkUpdate = (usedPercent: number) => ({
      rateLimits: {
        limitId: 'spark',
        limitName: null,
        primary: { usedPercent, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        credits: null,
      },
    })

    function liveAdapter(state: Partial<SourceState>, limitMemory: CodexLimitMemory) {
      const source = sourceAdapter({ account: chatgpt, ...state }, { limitMemory })
      const updated = vi.fn()
      const changed = vi.fn()
      source.adapter.onLimitsUpdated(updated)
      source.adapter.onUsageChanged(changed)
      return { ...source, updated, changed }
    }

    it('reports the windows and credits of an update as rows the read already named', async () => {
      const { adapter, rpc, updated, changed } = liveAdapter(
        { rateLimitsResponse: capturedRead },
        new CodexLimitMemory(),
      )
      await adapter.start()
      await expect(adapter.rateLimitSource()).resolves.toEqual({
        status: 'ready',
        limits: [
          {
            id: 'codex:primary',
            label: 'Weekly',
            usedPercent: 1,
            resetsAt: 1_792_673_856_000,
            windowMinutes: 10_080,
          },
          { id: 'credits', label: 'Credits', usedPercent: 0, valueLabel: '$50.00 · 1250 credits' },
        ],
      })

      rpc.emitNotification('account/rateLimits/updated', rollingUpdate)

      expect(updated).toHaveBeenCalledExactlyOnceWith([
        {
          id: 'codex:primary',
          label: 'Weekly',
          usedPercent: 3,
          resetsAt: 1_792_673_856_000,
          windowMinutes: 10_080,
        },
        { id: 'credits', label: 'Credits', usedPercent: 0, valueLabel: '$49.96 · 1249 credits' },
      ])
      // The values arrived; nothing has to be read again.
      expect(changed).not.toHaveBeenCalled()
      adapter.dispose()
    })

    it('keeps the read name of a bucket that a sparse update leaves out', async () => {
      const memory = new CodexLimitMemory()
      const { adapter, rpc, updated } = liveAdapter({ rateLimitsResponse: sparkRead }, memory)
      await adapter.start()
      await adapter.rateLimitSource()

      rpc.emitNotification('account/rateLimits/updated', sparkUpdate(40))
      // A null window is unknown in this update, not gone.
      rpc.emitNotification('account/rateLimits/updated', {
        rateLimits: { limitId: 'spark', primary: null, secondary: null },
      })

      expect(updated).toHaveBeenCalledExactlyOnceWith([
        {
          id: 'spark:primary',
          label: 'GPT-5.3-Codex-Spark 5 hours',
          usedPercent: 40,
          windowMinutes: 300,
        },
      ])
      adapter.dispose()
    })

    it('shares the newest read with a chat process in the same home, and only that home', async () => {
      const memory = new CodexLimitMemory()
      const control = liveAdapter(
        { rateLimitsResponse: sparkRead, home: 'C:\\fixture\\.codex' },
        memory,
      )
      await control.adapter.start()
      await control.adapter.rateLimitSource()
      await control.adapter.dispose()

      const chat = liveAdapter({ home: 'C:\\fixture\\.codex' }, memory)
      await chat.adapter.start()
      chat.rpc.emitNotification('account/rateLimits/updated', sparkUpdate(20))
      const other = liveAdapter({ home: 'D:\\other\\.codex' }, memory)
      await other.adapter.start()
      other.rpc.emitNotification('account/rateLimits/updated', sparkUpdate(20))

      expect(chat.updated.mock.lastCall?.[0]).toMatchObject([
        { id: 'spark:primary', label: 'GPT-5.3-Codex-Spark 5 hours' },
      ])
      expect(other.updated.mock.lastCall?.[0]).toMatchObject([
        { id: 'spark:primary', label: 'Spark 5 hours' },
      ])
      chat.adapter.dispose()
      other.adapter.dispose()
    })

    it('only signals a usage change where the process may run on another account', async () => {
      const source = sourceAdapter(
        { account: chatgpt },
        { liveLimits: false, limitMemory: new CodexLimitMemory() },
      )
      const updated = vi.fn()
      const changed = vi.fn()
      source.adapter.onLimitsUpdated(updated)
      source.adapter.onUsageChanged(changed)
      await source.adapter.start()

      source.rpc.emitNotification('account/rateLimits/updated', rollingUpdate)

      expect(changed).toHaveBeenCalledOnce()
      expect(updated).not.toHaveBeenCalled()
      source.adapter.dispose()
    })

    it('signals a usage change for an update it cannot read', async () => {
      const { adapter, rpc, updated, changed } = liveAdapter({}, new CodexLimitMemory())
      await adapter.start()

      rpc.emitNotification('account/rateLimits/updated', { rateLimits: 'changed' })

      expect(changed).toHaveBeenCalledOnce()
      expect(updated).not.toHaveBeenCalled()
      adapter.dispose()
    })
  })

  it.each([
    ['signed out', null],
    ['API key', { type: 'apiKey' }],
    ['Bedrock', { type: 'amazonBedrock', credentialSource: 'environment' }],
  ] satisfies Array<[string, JsonRpcValue]>)(
    'marks %s accounts unavailable without requesting subscription limits',
    async (_name, account) => {
      const { adapter, rpc } = sourceAdapter({ account })
      await adapter.start()

      await expect(adapter.rateLimitSource()).resolves.toEqual({ status: 'unavailable' })
      expect(rpc.calls.map(({ method }) => method)).not.toContain('account/rateLimits/read')
      adapter.dispose()
    },
  )

  it('marks a successful ChatGPT subscription response ready, including empty limits', async () => {
    const { adapter, rpc } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).resolves.toEqual({ status: 'ready', limits: [] })
    expect(rpc.calls.map(({ method }) => method)).toContain('account/rateLimits/read')
    expect(rpc.calls.filter(({ method }) => method.includes('account/'))).toMatchObject([
      { method: 'account/read', timeoutMs: 10_000 },
      { method: 'account/rateLimits/read', timeoutMs: 10_000 },
    ])
    adapter.dispose()
  })

  it('skips reset-credit details for a background read and says when some exist', async () => {
    const { adapter, rpc, state } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      rateLimitsResponse: { ...emptyRateLimits, rateLimitResetCredits: { availableCount: 0 } },
    })
    await adapter.start()
    await expect(adapter.rateLimitSource({ background: true })).resolves.toEqual({
      status: 'ready',
      limits: [],
    })
    state.rateLimitsResponse = {
      ...emptyRateLimits,
      rateLimitResetCredits: { availableCount: 2, credits: null },
    }
    await expect(adapter.rateLimitSource({ background: true })).resolves.toMatchObject({
      detailsOmitted: true,
    })
    await expect(adapter.rateLimitSource()).resolves.not.toHaveProperty('detailsOmitted')
    expect(
      rpc.calls.filter(({ method }) => method === 'account/rateLimits/read').map((c) => c.params),
    ).toEqual([{ excludeResetCreditDetails: true }, { excludeResetCreditDetails: true }, {}])
    adapter.dispose()
  })

  it('reads in full when a Codex before 0.163 refuses the background parameter', async () => {
    const rpc = new FakeCodexRpc((method, params) => {
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: null, planType: 'pro' } }
      if (method !== 'account/rateLimits/read') return {}
      if (params && typeof params === 'object' && 'excludeResetCreditDetails' in params) {
        throw new JsonRpcError(-32602, 'Invalid params')
      }
      return emptyRateLimits
    })
    proc.rpc = rpc
    const adapter = new CodexAdapter({ limitMemory: new CodexLimitMemory() })
    await adapter.start()
    await expect(adapter.rateLimitSource({ background: true })).resolves.toEqual({
      status: 'ready',
      limits: [],
    })
    adapter.dispose()
  })

  it('accepts a reset-credit summary without optional detail rows', async () => {
    const { adapter } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      rateLimitsResponse: {
        ...emptyRateLimits,
        rateLimitResetCredits: { availableCount: 2 },
      },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).resolves.toEqual({
      status: 'ready',
      limits: [
        {
          id: 'resets',
          label: 'Rate limit resets',
          usedPercent: 0,
          valueLabel: '2 available',
          action: 'consume-reset',
        },
      ],
    })
    adapter.dispose()
  })

  it('preserves available reset expiries through the provider response parser', async () => {
    const { adapter } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      rateLimitsResponse: {
        ...emptyRateLimits,
        rateLimitResetCredits: {
          availableCount: 5,
          credits: [
            {
              id: 'reset-fixture',
              resetType: 'codexRateLimits',
              status: 'available',
              grantedAt: 1_788_581_958,
              expiresAt: 1_791_173_958,
              title: 'Full reset',
              description: 'One free rate limit reset.',
            },
            { status: 'available', expiresAt: null },
            { status: 'available', expiresAt: 1_790_000_000 },
            { status: 'redeemed', expiresAt: 1_788_000_000 },
            { status: 'redeeming', expiresAt: 1_788_000_000 },
            { status: 'available', expiresAt: 'unknown' },
            { status: 'available', expiresAt: Number.MAX_SAFE_INTEGER },
          ],
        },
      },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).resolves.toEqual({
      status: 'ready',
      limits: [
        {
          id: 'resets',
          label: 'Rate limit resets',
          usedPercent: 0,
          valueLabel: '5 available',
          action: 'consume-reset',
          resetCredits: [
            { id: 'reset-fixture', expiresAt: 1_791_173_958_000 },
            { expiresAt: null },
            { expiresAt: 1_790_000_000_000 },
          ],
        },
      ],
    })
    adapter.dispose()
  })

  it.each(['account/read', 'account/rateLimits/read'])(
    'propagates a failed %s request',
    async (method) => {
      const { adapter } = sourceAdapter({
        account: { type: 'chatgpt', email: null, planType: 'pro' },
        failure: method,
      })
      await adapter.start()

      await expect(adapter.rateLimitSource()).rejects.toThrow(`${method} failed`)
      adapter.dispose()
    },
  )

  it('rejects a malformed successful account response', async () => {
    const { adapter } = sourceAdapter({ accountResponse: {} })
    await adapter.start()

    await expect(adapter.rateLimitSource()).rejects.toThrow('Codex account response was invalid.')
    adapter.dispose()
  })

  it('rejects a malformed successful rate-limit response', async () => {
    const { adapter } = sourceAdapter({
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      rateLimitsResponse: {
        rateLimits: {},
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
    })
    await adapter.start()

    await expect(adapter.rateLimitSource()).rejects.toThrow(
      'Codex rate-limit response was invalid.',
    )
    adapter.dispose()
  })
})

describe('Codex rate-limit reset consume', () => {
  it('passes the selected credit id to the provider', async () => {
    const { adapter, rpc } = sourceAdapter()
    await adapter.start()
    await expect(
      adapter.consumeRateLimitReset('8ae96ff3-3425-4f4c-8772-b6fd61502868', 'reset-fixture'),
    ).resolves.toBe('reset')
    expect(rpc.calls.at(-1)?.params).toEqual({
      idempotencyKey: '8ae96ff3-3425-4f4c-8772-b6fd61502868',
      creditId: 'reset-fixture',
    })
    adapter.dispose()
  })
  it('redeems the next available credit with the caller-supplied key', async () => {
    const { adapter, rpc } = sourceAdapter()
    await adapter.start()

    await expect(
      adapter.consumeRateLimitReset('8ae96ff3-3425-4f4c-8772-b6fd61502868'),
    ).resolves.toBe('reset')
    expect(rpc.calls.filter(({ method }) => method.includes('rateLimitReset'))).toEqual([
      {
        method: 'account/rateLimitResetCredit/consume',
        params: { idempotencyKey: '8ae96ff3-3425-4f4c-8772-b6fd61502868' },
        timeoutMs: 10_000,
      },
    ])
    adapter.dispose()
  })

  it.each(['nothingToReset', 'noCredit', 'alreadyRedeemed'] as const)(
    'returns the %s outcome without selecting a credit id',
    async (outcome) => {
      const { adapter, rpc } = sourceAdapter({ consumeResponse: { outcome } })
      await adapter.start()

      await expect(
        adapter.consumeRateLimitReset('8ae96ff3-3425-4f4c-8772-b6fd61502868'),
      ).resolves.toBe(outcome)
      expect(rpc.calls.at(-1)?.params).toEqual({
        idempotencyKey: '8ae96ff3-3425-4f4c-8772-b6fd61502868',
      })
      adapter.dispose()
    },
  )

  it('rejects a malformed successful consume response', async () => {
    const { adapter } = sourceAdapter({ consumeResponse: { outcome: 'ok' } })
    await adapter.start()

    await expect(
      adapter.consumeRateLimitReset('8ae96ff3-3425-4f4c-8772-b6fd61502868'),
    ).rejects.toThrow('Codex reset-credit response was invalid.')
    adapter.dispose()
  })
})
