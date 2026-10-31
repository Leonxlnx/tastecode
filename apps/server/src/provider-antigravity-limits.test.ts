import { afterEach, describe, expect, it, vi } from 'vitest'

const antigravity = vi.hoisted(() => ({
  account: vi.fn(async () => ({ signedIn: true })),
  limitSource: vi.fn(async () => ({
    status: 'ready' as const,
    limits: [
      { id: 'gemini-5h', label: 'Gemini 5 hours', usedPercent: 0, windowMinutes: 300 },
      {
        id: 'gemini-weekly',
        label: 'Gemini weekly',
        usedPercent: 0.48,
        resetsAt: Date.parse('2026-11-06T00:54:37Z'),
        windowMinutes: 10_080,
      },
    ],
  })),
}))

vi.mock('@harness/adapter-antigravity', () => ({
  antigravityAccount: antigravity.account,
  antigravityLimitSource: antigravity.limitSource,
}))

const { ProviderControls } = await import('./provider-controls.js')
const { PROVIDER_CAPABILITIES } = await import('./provider-capabilities.js')

const registries: InstanceType<typeof ProviderControls>[] = []
function setup() {
  const registry = new ProviderControls({ listModels: async () => [] })
  registries.push(registry)
  return registry
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.disposeAll()
  antigravity.account.mockClear()
  antigravity.limitSource.mockClear()
})

describe('Antigravity plan limits', () => {
  it('reads agy when a view shows the limits, never for a passive figure', async () => {
    expect(PROVIDER_CAPABILITIES.antigravity.usageLimits).toBe(true)
    expect(PROVIDER_CAPABILITIES.antigravity.limitReadsWhenShown).toBe(true)
    const control = setup().forProvider('antigravity')

    await expect(control.usageLimitSource('background')).resolves.toEqual({
      provider: 'antigravity',
      status: 'unavailable',
      reason: 'failed',
      error: 'Plan limits are read when you open them.',
    })
    expect(antigravity.limitSource).not.toHaveBeenCalled()

    await expect(control.usageLimitSource('visible')).resolves.toMatchObject({
      provider: 'antigravity',
      status: 'ready',
      origin: 'read',
      limits: [
        { id: 'gemini-5h', label: 'Gemini 5 hours' },
        { id: 'gemini-weekly', label: 'Gemini weekly', usedPercent: 0.48 },
      ],
    })
    expect(antigravity.limitSource).toHaveBeenCalledOnce()
  })

  it('keeps an agy without plan limits out of the shown sources', async () => {
    antigravity.limitSource.mockResolvedValueOnce({ status: 'unavailable' } as never)
    const control = setup().forProvider('antigravity')
    await expect(control.usageLimitSource('visible')).resolves.toEqual({
      provider: 'antigravity',
      status: 'unavailable',
    })
  })
})
